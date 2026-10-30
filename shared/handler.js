// One HTTP API for both deployments. The laptop server and the Netlify function each turn a
// request into { method, params, body }, pass a store and whatever models they have, and send
// back what this returns: { status, json } or { status, bytes, contentType }.
//
// Models (the laptop has them, Netlify has none):
//   decoder(photo, onImage, { room })        FlexTok ladder of a photo, rung by rung
//   imagine.prepare(label, replaces) -> job  FlexAR starts writing a class's tokens
//   imagine.ladder(job, onImage, { room })   ladder of those tokens, rung by rung
//   judge(image, answers, guess) -> { verdict: "match" | "warm" | "miss" }   CLIP
//   classes: [[name, [synonyms]], ...]       the 1000 classes FlexAR knows
//
// Store interface:
//   getRoom(code)                 -> { room, version } | null
//   putRoom(code, room, version)  -> true, or false if someone else wrote first (version null = must be new)
//   putImage(key, bytes)          / getImage(key) -> Uint8Array | null
import * as G from "./logic.js";

const MAX_IMAGE = 400 * 1024;

const ok = (json) => ({ status: 200, json });
const fail = (status, error) => ({ status, json: { error } });

export async function handle(req, ctx) {
	const { store } = ctx;
	const now = ctx.now ?? Date.now();
	const p = { ...(req.params ?? {}), ...(req.body ?? {}) };
	const code = String(p.code ?? "").toUpperCase().trim();
	try {
		switch (p.action) {
			case "info":
				return ok({
					decoder: ctx.decoderName ?? "standin",
					imagine: !!(ctx.imagine && ctx.classes),
					judge: !!ctx.judge,
					rungs: G.RUNGS,
					points: G.POINTS,
				});

			case "create": {
				for (let i = 0; i < 10; i++) {
					const c = G.randomCode();
					const { room, player } = G.createRoom(c, p.name, now);
					if (await store.putRoom(c, room, null)) return ok({ code: c, pid: player.id, token: player.token });
				}
				return fail(503, "Couldn't find a free room code, try again.");
			}

			case "join": {
				let player;
				await mutate(store, code, (room) => {
					player = G.joinRoom(room, p.name, now);
				});
				return ok({ code, pid: player.id, token: player.token });
			}

			case "state": {
				const got = await store.getRoom(code);
				if (!got) return fail(404, "That room doesn't exist.");
				const me = G.findPlayer(got.room, p.pid, p.token);
				const touched = G.touch(got.room, me, now); // before advance, so the poller counts as here
				const changed = G.advance(got.room, now);
				if (changed || touched) {
					const saved = await store.putRoom(code, got.room, got.version);
					// A lost phase change is harmless (the next poll recomputes it from timestamps), but a
					// lost "still here" would make an active player look away, so retry that one
					if (!saved && touched) {
						const room = await mutate(store, code, (r) => {
							G.advance(r, now);
							G.findPlayer(r, p.pid, p.token).lastSeen = now;
						});
						return ok(G.view(room, me.id, now));
					}
				}
				return ok(G.view(got.room, me.id, now));
			}

			case "start":
				return await act(store, code, p, now, (room, me) => G.startGame(room, me.id, now));
			case "leave":
				return await act(store, code, p, now, (room, me) => G.leaveRoom(room, me.id, now));
			case "guess":
				return await submitGuess(store, code, p, ctx, now);
			case "pick":
				return await act(store, code, p, now, (room, me) => G.submitPick(room, me.id, p.choice, now));
			case "judge":
				return await act(store, code, p, now, (room, me) => G.judgeGuess(room, me.id, p.guessId, p.correct));
			case "next":
				return await act(store, code, p, now, (room, me) => G.skipWait(room, me.id, now));
			case "again":
				return await act(store, code, p, now, (room, me) => G.playAgain(room, me.id));

			case "prepare":
				return await prepare(store, code, p, ctx, now);
			case "photo":
				return await submitRound(store, code, p, ctx);

			case "img": {
				const got = await store.getRoom(code);
				if (!got) return fail(404, "That room doesn't exist.");
				const me = G.findPlayer(got.room, p.pid, p.token);
				const rung = p.rung === "photo" ? "photo" : Number(p.rung);
				if (rung !== "photo" && !(Number.isInteger(rung) && rung >= 0 && rung < G.RUNGS.length))
					return fail(400, "Bad image.");
				if (!G.canSeeImage(got.room, me.id, String(p.round), rung, now)) return fail(403, "Not yet!");
				const bytes = await store.getImage(imageKey(code, p.round, rung));
				if (!bytes) return fail(404, "Image not found.");
				return { status: 200, bytes, contentType: sniff(bytes) };
			}

			default:
				return fail(400, "Unknown action.");
		}
	} catch (e) {
		if (e instanceof G.GameError) return fail(e.status, e.message);
		console.error(e);
		return fail(500, "Something went wrong on the server.");
	}
}

async function act(store, code, p, now, fn) {
	await mutate(store, code, (room) => {
		const me = G.findPlayer(room, p.pid, p.token);
		G.advance(room, now);
		fn(room, me);
	});
	return ok({ ok: true });
}

// Read, change, write with a version check, retrying when another request got there first
async function mutate(store, code, fn) {
	for (let attempt = 0; attempt < 8; attempt++) {
		const got = await store.getRoom(code);
		if (!got) throw new G.GameError("That room doesn't exist.", 404);
		fn(got.room);
		if (await store.putRoom(code, got.room, got.version)) return got.room;
		await new Promise((r) => setTimeout(r, 20 + Math.random() * 60));
	}
	throw new G.GameError("The room is busy, try again.", 409);
}

function imagineClass(ctx, label) {
	const i = Number(label);
	if (!ctx.imagine || !ctx.classes) throw new G.GameError("Imagine rounds need the host laptop's FlexAR.");
	if (!Number.isInteger(i) || !ctx.classes[i]) throw new G.GameError("Pick something from the list.");
	return { label: i, name: ctx.classes[i][0], synonyms: ctx.classes[i][1] };
}

// Imagine rounds: FlexAR starts writing as soon as the photographer picks a class, so the
// picture is mostly written by the time they've typed alternates, decoys and their bet
async function prepare(store, code, p, ctx, now) {
	const c = imagineClass(ctx, p.label);
	const got = await store.getRoom(code);
	if (!got) return fail(404, "That room doesn't exist.");
	const me = G.findPlayer(got.room, p.pid, p.token);
	G.advance(got.room, now);
	if (got.room.phase !== "shoot" || G.currentRound(got.room)?.photographerId !== me.id)
		throw new G.GameError("It isn't your turn.", 403);
	const job = await ctx.imagine.prepare(c.label, p.replaces ?? null);
	return ok({ job });
}

// Runs a ladder, storing each rung as it arrives. Resolves once rung 0 is stored (true) or the
// ladder has ended without it (false); later rungs keep arriving in the background, and any
// it misses are filled in by fill(i) so the round goes on.
async function streamLadder(store, code, roundId, run, fill, ctx) {
	const stored = new Set();
	let firstReady;
	const first = new Promise((resolve) => (firstReady = resolve));
	const done = run(async (i, bytes) => {
		await store.putImage(imageKey(code, roundId, i), bytes);
		stored.add(i);
		if (i === 0) firstReady(true);
	})
		.catch((e) => console.error("ladder stopped early:", e.message))
		.then(async () => {
			if (stored.has(0)) for (let i = 0; i < G.RUNGS.length; i++) if (!stored.has(i)) await fill(i, stored);
			firstReady(stored.has(0));
			return stored;
		});
	ctx.background?.(done);
	return { ok: await first, done };
}

async function submitRound(store, code, p, ctx) {
	const imagine = p.mode === "imagine";
	const c = imagine ? imagineClass(ctx, p.label) : null;
	const setup = G.cleanSetup({
		mode: imagine ? "imagine" : "camera",
		answer: imagine ? c.name : p.answer,
		alternates: p.alternates,
		synonyms: c?.synonyms,
		decoys: p.decoys,
		call: p.call,
	});
	let photo = null;
	let ladder = null;
	if (!imagine) {
		photo = dataUrlToBytes(p.photo);
		ladder = Array.isArray(p.ladder) ? p.ladder.map(dataUrlToBytes) : [];
		if (!photo) return fail(400, "Your photo didn't come through, try again.");
		if (ladder.length !== G.RUNGS.length || ladder.some((b) => !b)) return fail(400, "The picture ladder is incomplete.");
	}

	const t0 = Date.now();
	const start = ctx.now ?? t0;
	const elapsed = () => start + (Date.now() - t0);
	let roundId;
	const developing = imagine || ctx.decoder != null;
	await mutate(store, code, (room) => {
		const me = G.findPlayer(room, p.pid, p.token);
		G.advance(room, start);
		if (developing) G.beginDevelop(room, me.id, setup, start);
		else if (room.phase !== "shoot" || G.currentRound(room)?.photographerId !== me.id)
			throw new G.GameError("It isn't your turn to shoot.", 403);
		roundId = G.currentRound(room).id;
	});

	let decoder = "standin";
	if (imagine) {
		// FlexAR writes, FlexTok decodes; a rung FlexAR never reached repeats the last one there is,
		// and the final picture stands in for the "original" at the end of the round
		const job = p.job || (await ctx.imagine.prepare(c.label, null));
		const last = async (i, stored) => {
			const j = Math.max(...[...stored].filter((x) => x < i), 0);
			await store.putImage(imageKey(code, roundId, i), await store.getImage(imageKey(code, roundId, j)));
		};
		const { ok: started, done } = await streamLadder(store, code, roundId, (onImage) => ctx.imagine.ladder(job, onImage, { room: code }), last, ctx);
		if (!started) {
			await mutate(store, code, (room) => G.cancelDevelop(room, G.findPlayer(room, p.pid, p.token).id, elapsed()));
			throw new G.GameError("FlexAR couldn't imagine that one. Try again or pick something else.", 503);
		}
		done.then(async (stored) => {
			const top = Math.max(...stored);
			await store.putImage(imageKey(code, roundId, "photo"), await store.getImage(imageKey(code, roundId, top)));
		});
		decoder = "flexar";
	} else {
		await store.putImage(imageKey(code, roundId, "photo"), photo);
		if (ctx.decoder) {
			// FlexTok streams the rungs coarse to fine; the round starts once the 2-byte picture is
			// stored and decoding carries on in the background, staying ahead of the reveal. Any
			// rung it fails to deliver comes from the browser's stand-in ladder.
			const fill = (i) => store.putImage(imageKey(code, roundId, i), ladder[i]);
			const { ok: started } = await streamLadder(store, code, roundId, (onImage) => ctx.decoder(photo, onImage, { room: code }), fill, ctx);
			if (started) decoder = ctx.decoderName ?? "flextok";
			else await Promise.all(ladder.map((b, i) => fill(i)));
		} else {
			await Promise.all(ladder.map((b, i) => store.putImage(imageKey(code, roundId, i), b)));
		}
	}

	await mutate(store, code, (room) => {
		const me = G.findPlayer(room, p.pid, p.token);
		if (G.currentRound(room)?.id !== roundId) throw new G.GameError("Your turn ran out while developing.");
		G.beginReveal(room, me.id, setup, decoder, elapsed(), start);
	});
	return ok({ ok: true, decoder });
}

// The picture a typed guess is judged against: the photo itself, or for an Imagine round the
// sharpest rung developed so far that the guesser has been allowed to see
async function referenceImage(store, code, r, now) {
	if (r.mode !== "imagine") return store.getImage(imageKey(code, r.id, "photo"));
	for (let i = Math.max(G.rungAt(r, now), 0); i >= 0; i--) {
		const b = await store.getImage(imageKey(code, r.id, i));
		if (b) return b;
	}
	return null;
}

// Spelling is checked in the rules; meaning (CLIP) only for guesses spelling doesn't settle.
// The rung is fixed by when the guess arrived, not by how long judging took.
async function submitGuess(store, code, p, ctx, now) {
	let verdict = "miss";
	const text = String(p.text ?? "").trim();
	if (ctx.judge && text) {
		const got = await store.getRoom(code);
		if (!got) return fail(404, "That room doesn't exist.");
		const me = G.findPlayer(got.room, p.pid, p.token);
		const r = G.currentRound(got.room);
		if (got.room.phase === "reveal" && r && !r.choices && r.photographerId !== me.id && !G.anyMatch(text, r.answers)) {
			const image = await referenceImage(store, code, r, now);
			if (image) {
				try {
					verdict = (await ctx.judge(image, r.answers, text.slice(0, 40))).verdict;
				} catch (e) {
					console.error("judge unavailable, spelling only:", e.message);
				}
			}
		}
	}
	return await act(store, code, p, now, (room, me) => G.submitGuess(room, me.id, p.text, now, verdict));
}

export function imageKey(code, roundId, rung) {
	return `img/${code}/${String(roundId).replace(/[^a-z0-9]/gi, "")}/${rung}`;
}

function dataUrlToBytes(s) {
	const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(s ?? ""));
	if (!m) return null;
	const bin = atob(m[2]);
	if (bin.length > MAX_IMAGE) return null;
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function sniff(b) {
	if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
	if (b[0] === 0x52 && b[1] === 0x49) return "image/webp";
	return "image/jpeg";
}
