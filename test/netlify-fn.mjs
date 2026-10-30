// Runs the real Netlify function (netlify/functions/game.ts) against Netlify's local Blobs
// server. The emulator's conditional writes compare file mtimes and aren't atomic, so races
// are checked one step at a time here (a stale write must be refused); the retry-on-conflict
// path under real concurrency is covered by test/sim.mjs with the memory store:
//   node test/netlify-fn.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BlobsServer } from "@netlify/blobs/server";
import { getStore } from "@netlify/blobs";
import { blobsStore } from "../shared/blobs-store.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hfb-blobs-"));
const token = "test-token";
const server = new BlobsServer({ directory: dir, token });
const { port } = await server.start();
const url = `http://localhost:${port}`;
process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ edgeURL: url, uncachedEdgeURL: url, siteID: "test-site", token })).toString("base64");
const { default: fn } = await import("../netlify/functions/game.ts");

const JPEG = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
async function call(params, method = "POST") {
	const req =
		method === "GET"
			? new Request(`https://x.netlify.app/.netlify/functions/game?${new URLSearchParams(params)}`)
			: new Request("https://x.netlify.app/.netlify/functions/game", { method, body: JSON.stringify(params) });
	const res = await fn(req);
	const type = res.headers.get("content-type");
	return { status: res.status, type, json: type === "application/json" ? await res.json() : null };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
	const info = await call({ action: "info" }, "GET");
	assert.equal(info.json.decoder, "standin");

	const host = (await call({ action: "create", name: "Ann" })).json;
	const code = host.code;
	// A write based on an old read must be refused, which is what makes the handler retry
	const rooms = blobsStore(getStore({ name: "how-few-bytes", consistency: "strong" }));
	const a = await rooms.getRoom(code);
	const b = await rooms.getRoom(code);
	await sleep(5); // the emulator's etags have millisecond resolution
	assert.equal(await rooms.putRoom(code, a.room, a.version), true);
	await sleep(5);
	assert.equal(await rooms.putRoom(code, b.room, b.version), false, "stale write refused");
	assert.equal(await rooms.putRoom(code, b.room, null), false, "create refused when the room exists");

	const names = ["Bo", "Cy", "Di", "Ed", "Flo", "Gus", "Hal"];
	const joins = [];
	for (const name of names) joins.push(await call({ action: "join", code, name }));
	assert.ok(joins.every((j) => j.status === 200), JSON.stringify(joins.map((j) => j.json)));
	const as = (who, params, method) => call({ ...params, code, pid: who.pid, token: who.token }, method);
	let s = (await as(host, { action: "state" }, "GET")).json;
	assert.deepEqual(s.players.map((p) => p.name).sort(), ["Ann", ...names].sort());
	assert.equal((await call({ action: "join", code, name: "Ivy" })).status, 400, "ninth player refused");

	// Everyone but Bo leaves, then play one round
	for (const j of joins.slice(1)) await as(j.json, { action: "leave" });
	const bo = joins[0].json;
	assert.equal((await as(host, { action: "start" })).status, 200);
	const sent = await as(host, { action: "photo", photo: JPEG, ladder: Array(9).fill(JPEG), answer: "apple", call: 0 });
	assert.equal(sent.status, 200, JSON.stringify(sent.json));
	s = (await as(bo, { action: "state" }, "GET")).json;
	assert.equal(s.phase, "reveal");
	assert.equal((await as(bo, { action: "img", round: s.round.id, rung: 0 }, "GET")).status, 403);
	await sleep(3300);
	const img = await as(bo, { action: "img", round: s.round.id, rung: 0 }, "GET");
	assert.equal(img.status, 200);
	assert.equal(img.type, "image/jpeg");
	assert.equal((await as(bo, { action: "guess", text: "an apple" })).status, 200);
	s = (await as(bo, { action: "state" }, "GET")).json;
	assert.equal(s.phase, "roundEnd");
	assert.deepEqual(s.round.roundPoints.map((x) => x.pts).sort(), [100, 75], "100 at 2 B; photographer 50 + 25 bet");
	assert.equal((await as(bo, { action: "img", round: s.round.id, rung: "photo" }, "GET")).status, 200);
	assert.equal((await as(host, { action: "next" })).status, 200);
	s = (await as(bo, { action: "state" }, "GET")).json;
	assert.equal(s.phase, "shoot");
	assert.equal(s.round.photographerId, bo.pid);
	console.log("Netlify function + Blobs: ok (stale writes refused, 8 players joined, round played, images gated)");
} finally {
	await server.stop();
	await fs.rm(dir, { recursive: true, force: true });
}
