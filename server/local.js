// Laptop server: serves the game page and the same API path as the Netlify function, keeps rooms
// in memory, and uses the laptop's models (decoder/flextok_server.py) when they're running:
// FlexTok for Camera rounds, FlexAR for Imagine rounds, CLIP to judge guesses by meaning.
// Without them it plays exactly like the Netlify fallback.
//
//   node server/local.js                     (PORT=8787, DECODER_URL=http://127.0.0.1:8799)
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handle } from "../shared/handler.js";
import { memoryStore } from "../shared/memory-store.js";
import { readFileSync } from "node:fs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const PORT = Number(process.env.PORT ?? 8787);
const DECODER_URL = process.env.DECODER_URL ?? "http://127.0.0.1:8799";
const API = "/.netlify/functions/game";
const MAX_BODY = 6 * 1024 * 1024;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon" };

const store = memoryStore();
const classes = JSON.parse(readFileSync(path.join(ROOT, "imagenet-classes.json"), "utf8"));
const models = { flextok: false, flexar: false, clip: false };

async function checkModels() {
	let h = {};
	try {
		const r = await fetch(`${DECODER_URL}/health`, { signal: AbortSignal.timeout(2000) });
		if (r.ok) h = await r.json();
	} catch {
		// not running (yet)
	}
	const now = { flextok: h.ready === true, flexar: h.flexar === true, clip: h.clip === true };
	for (const [k, label] of [["flextok", "FlexTok (Camera rounds)"], ["flexar", "FlexAR (Imagine rounds)"], ["clip", "CLIP judging"]]) {
		if (now[k] !== models[k]) console.log(`${label}: ${now[k] ? "ready" : "unavailable"}`);
		models[k] = now[k];
	}
}

// Streams a ladder from the models server, handing each rung to onImage as soon as it is
// developed. A new round in the same room cancels that room's previous ladder, so the next
// round doesn't queue behind rungs only the last round's recap strip would show.
const inflight = new Map(); // room code -> AbortController

async function streamRungs(route, body, contentType, onImage, room) {
	inflight.get(room)?.abort();
	const ctl = new AbortController();
	inflight.set(room, ctl);
	const r = await fetch(`${DECODER_URL}${route}`, {
		method: "POST",
		headers: { "content-type": contentType },
		body,
		signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(150000)]),
	});
	if (!r.ok) throw new Error(`models server returned ${r.status}`);
	const decoder = new TextDecoder();
	let buf = "";
	let last = null;
	for await (const chunk of r.body) {
		buf += decoder.decode(chunk, { stream: true });
		let nl;
		while ((nl = buf.indexOf("\n")) !== -1) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (!line.trim()) continue;
			last = JSON.parse(line);
			await onImage(last.rung, Uint8Array.from(Buffer.from(last.image, "base64")));
		}
	}
	if (inflight.get(room) === ctl) inflight.delete(room);
	if (last?.rung !== 8) throw new Error(`ladder stopped after rung ${last?.rung ?? "none"}`);
	console.log(`ladder developed in ${last.seconds.toFixed(1)}s`);
}

async function postJSON(route, json, ms) {
	const r = await fetch(`${DECODER_URL}${route}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(json),
		signal: AbortSignal.timeout(ms),
	});
	if (!r.ok) throw new Error(`models server returned ${r.status}`);
	return r.json();
}

const flextokLadder = (photo, onImage, { room } = {}) => streamRungs("/ladder", photo, "image/jpeg", onImage, room);

const imagine = {
	prepare: async (label, replaces) => (await postJSON("/imagine/start", { label, replaces }, 5000)).job,
	ladder: (job, onImage, { room } = {}) => streamRungs("/imagine/ladder", JSON.stringify({ job }), "application/json", onImage, room),
};

const judge = (image, answers, guess) =>
	postJSON("/judge", { image: Buffer.from(image).toString("base64"), answers, guess }, 12000);

async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const c of req) {
		size += c.length;
		if (size > MAX_BODY) throw new Error("too large");
		chunks.push(c);
	}
	return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
}

async function api(req, res, url) {
	let body = null;
	if (req.method === "POST") {
		try {
			body = await readBody(req);
		} catch {
			return send(res, 400, { error: "Bad request." });
		}
	}
	const out = await handle(
		{ method: req.method, params: Object.fromEntries(url.searchParams), body },
		{
			store,
			now: Date.now(),
			decoder: models.flextok ? flextokLadder : null,
			decoderName: models.flextok ? "flextok" : "standin",
			imagine: models.flexar && models.flextok ? imagine : null,
			judge: models.clip ? judge : null,
			classes,
		},
	);
	if (out.bytes) {
		res.writeHead(out.status, { "content-type": out.contentType, "cache-control": "private, max-age=3600" });
		return res.end(Buffer.from(out.bytes));
	}
	send(res, out.status, out.json);
}

function send(res, status, json) {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(json));
}

async function serveStatic(res, pathname) {
	const file = path.normalize(path.join(ROOT, pathname === "/" ? "index.html" : pathname));
	if (!file.startsWith(ROOT)) return send(res, 404, { error: "Not found." });
	try {
		const data = await fs.readFile(file);
		res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
		res.end(data);
	} catch {
		send(res, 404, { error: "Not found." });
	}
}

http
	.createServer(async (req, res) => {
		const url = new URL(req.url, "http://localhost");
		try {
			if (url.pathname === API) return await api(req, res, url);
			return await serveStatic(res, url.pathname);
		} catch (e) {
			console.error(e);
			send(res, 500, { error: "Server error." });
		}
	})
	.listen(PORT, () => {
		console.log(`How Few Bytes? on http://localhost:${PORT}`);
		checkModels();
		setInterval(checkModels, 5000);
	});
