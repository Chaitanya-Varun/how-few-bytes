// Plays complete games against the shared handler with a fake clock, no browser needed:
//   node test/sim.mjs
import assert from "node:assert/strict";
import { handle } from "../shared/handler.js";
import { memoryStore } from "../shared/memory-store.js";
import * as G from "../shared/logic.js";

const JPEG = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
let now = 1_000_000;

function client(store, decoder = null) {
	return async (params) => {
		const res = await handle({ params }, { store, now, decoder, decoderName: decoder ? "flextok" : "standin" });
		return res;
	};
}

async function game({ players, decoder = null }) {
	const store = memoryStore();
	const call = client(store, decoder);
	const ids = [];
	const created = await call({ action: "create", name: players[0] });
	assert.equal(created.status, 200, JSON.stringify(created.json));
	const code = created.json.code;
	ids.push(created.json);
	for (const n of players.slice(1)) {
		const j = await call({ action: "join", code, name: n });
		assert.equal(j.status, 200, JSON.stringify(j.json));
		ids.push(j.json);
	}
	const as = (i, params) => call({ ...params, code, pid: ids[i].pid, token: ids[i].token });
	const state = async (i) => (await as(i, { action: "state" })).json;
	const pollAll = () => Promise.all(ids.map((_, i) => state(i)));

	assert.equal((await as(1, { action: "start" })).status, 403, "non-host can't start");
	assert.equal((await as(0, { action: "start" })).status, 200);
	assert.equal((await as(0, { action: "join", name: "Late" })).status, 400, "no late joins");

	let s = await state(0);
	const total = s.totalRounds;
	assert.equal(total, players.length * (players.length <= 3 ? 2 : 1));

	for (let round = 0; round < total; round++) {
		s = await state(0);
		assert.equal(s.phase, "shoot");
		const ph = ids.findIndex((x) => x.pid === s.round.photographerId);
		if (process.env.DEBUG) console.log(round, s.roundNumber, s.players.map((p) => [p.name, p.active]));
		assert.equal(ph, round % players.length, "photographer rotates in join order");
		const guesser = (ph + 1) % players.length;

		// A guesser can't send a photo, and can't peek at the image
		assert.equal((await as(guesser, { action: "photo", photo: JPEG, ladder: Array(9).fill(JPEG), answer: "x" })).status, 403);
		const r = await as(ph, { action: "photo", photo: JPEG, ladder: Array(9).fill(JPEG), answer: "Coffee Mug", call: 3 });
		assert.equal(r.status, 200, JSON.stringify(r.json));
		s = await state(guesser);
		assert.equal(s.phase, "reveal");
		assert.equal(s.round.answer, null, "answer hidden from guessers");
		const rid = s.round.id;
		assert.equal((await as(guesser, { action: "img", round: rid, rung: 0 })).status, 403, "rung 0 hidden in countdown");
		assert.equal((await as(guesser, { action: "guess", text: "cup" })).status, 400, "no guesses in countdown");

		now += G.COUNTDOWN_MS + 500; // rung 0 (2 bytes)
		await pollAll();
		assert.equal((await as(guesser, { action: "img", round: rid, rung: 0 })).status, 200);
		assert.equal((await as(guesser, { action: "img", round: rid, rung: 1 })).status, 403, "future rung hidden");
		assert.equal((await as(guesser, { action: "img", round: rid, rung: "photo" })).status, 403, "original hidden");
		assert.equal((await as(ph, { action: "img", round: rid, rung: "photo" })).status, 200, "photographer sees original");

		const wrong = await as(guesser, { action: "guess", text: "cup" });
		assert.equal(wrong.status, 200);
		assert.equal((await as(guesser, { action: "guess", text: "mug" })).status, 400, "one guess per rung");

		now += G.RUNG_MS * 3; // rung 3 (16 bytes)
		await pollAll();
		const right = await as(guesser, { action: "guess", text: "coffee mugs" });
		assert.equal(right.status, 200);
		s = await state(ph);
		assert.ok(s.round.guesses.find((g) => g.text === "coffee mugs").correct, "plural auto-accepted");

		// Photographer accepts the earlier "cup" guess for a third player, or for the guesser
		const cup = s.round.guesses.find((g) => g.text === "cup");
		assert.equal((await as(guesser, { action: "judge", guessId: cup.id, correct: true })).status, 403);
		if (players.length > 2) {
			const third = (ph + 2) % players.length;
			now += G.RUNG_MS; // rung 4
			assert.equal((await as(third, { action: "guess", text: "a cofee mug" })).status, 200, "typo");
			// Remaining players guess right so the round ends early
			for (let k = 3; k < players.length; k++) {
				const other = (ph + k) % players.length;
				assert.equal((await as(other, { action: "guess", text: "mug" })).status, 200);
				const os = await state(ph);
				const g = os.round.guesses.findLast((x) => x.text === "mug");
				await as(ph, { action: "judge", guessId: g.id, correct: true });
			}
		} else {
			await as(ph, { action: "judge", guessId: cup.id, correct: true });
		}
		now += 1; // the round ends once every guesser is right (judging counts on the next poll)
		s = await state(ph);
		assert.equal(s.phase, "roundEnd", "round ends when every guesser is right");
		const gp = s.round.roundPoints;
		const guesserPts = gp.find((x) => x.name === players[guesser]).pts;
		if (players.length === 2) assert.equal(guesserPts, 100, "accepted 2-byte guess beats later one");
		else assert.equal(guesserPts, 70);
		const phPts = gp.find((x) => x.isPhotographer).pts;
		assert.equal(phPts, Math.round(Math.max(...gp.filter((x) => !x.isPhotographer).map((x) => x.pts)) / 2) + (s.round.callHit ? 25 : 0));
		assert.equal((await as(guesser, { action: "img", round: rid, rung: "photo" })).status, 200, "original after round");

		now += G.ROUNDEND_MS + 1;
	}
	s = await state(1);
	assert.equal(s.phase, "over");
	assert.equal(s.standings.length, players.length);
	assert.ok(s.threshold > 0);
	assert.equal((await as(1, { action: "again" })).status, 403);
	assert.equal((await as(0, { action: "again" })).status, 200);
	assert.equal((await state(1)).phase, "lobby");
	return s;
}

async function timeouts() {
	const store = memoryStore();
	const call = client(store);
	const a = (await call({ action: "create", name: "Ann" })).json;
	const b = (await call({ action: "join", code: a.code, name: "Bo" })).json;
	assert.equal((await call({ action: "join", code: a.code, name: "bo" })).status, 400, "duplicate name");
	const as = (who, p) => call({ ...p, code: a.code, pid: who.pid, token: who.token });
	await as(a, { action: "start" });
	now += G.SHOOT_MS + 1; // Ann never shoots
	let s = (await as(b, { action: "state" })).json;
	assert.equal(s.phase, "shoot");
	assert.equal(s.round.photographerId, b.pid, "slow photographer is skipped");
	await as(b, { action: "photo", photo: JPEG, ladder: Array(9).fill(JPEG), answer: "cat" });
	now += G.COUNTDOWN_MS + 9 * G.RUNG_MS + 1; // nobody guesses
	s = (await as(a, { action: "state" })).json;
	assert.equal(s.phase, "roundEnd");
	assert.equal(s.round.firstRung, null);
	assert.equal(s.players.find((p) => p.id === b.pid).score, 0, "unguessed photo scores nothing");
	await as(a, { action: "leave" });
	s = (await as(b, { action: "state" })).json;
	assert.equal(s.phase, "over", "game ends below 2 players");
	assert.equal(s.hostId, b.pid, "host passes on");
}

async function decoderPath() {
	const decoded = [];
	// Develops rungs 0-4 with FlexTok, then fails: the rest must come from the stand-in ladder
	const decoder = async (bytes, onImage) => {
		decoded.push(bytes.length);
		for (let i = 0; i < 5; i++) await onImage(i, Uint8Array.from([0x89, 0x50, 1, 2]));
		throw new Error("GPU fell over");
	};
	const store = memoryStore();
	const call = client(store, decoder);
	const a = (await call({ action: "create", name: "Ann" })).json;
	const b = (await call({ action: "join", code: a.code, name: "Bo" })).json;
	const as = (who, p) => call({ ...p, code: a.code, pid: who.pid, token: who.token });
	assert.equal((await call({ action: "info" })).json.decoder, "flextok");
	await as(a, { action: "start" });
	const sent = now;
	const r = await as(a, { action: "photo", photo: JPEG, ladder: Array(9).fill(JPEG), answer: "dog" });
	assert.equal(r.json.decoder, "flextok");
	const rs = (await as(b, { action: "state" })).json;
	assert.equal(rs.round.revealAt, sent + G.COUNTDOWN_MS, "countdown runs from when the photo arrived");
	assert.equal(decoded.length, 1);
	now += G.COUNTDOWN_MS + 1;
	const s = (await as(b, { action: "state" })).json;
	const img = await as(b, { action: "img", round: s.round.id, rung: 0 });
	assert.equal(img.contentType, "image/png", "FlexTok images served");
	now += 8 * G.RUNG_MS;
	const late = await as(b, { action: "img", round: s.round.id, rung: 8 });
	assert.equal(late.contentType, "image/jpeg", "missing rungs filled from the stand-in");
}

// A slow first rung (4.3 s) overlaps the countdown: the picture shows 1 s after it exists, not 3 s
{
	const { room, player } = G.createRoom("TEST", "Ann", 0);
	G.joinRoom(room, "Bo", 0);
	G.startGame(room, player.id, 0);
	const setup = G.cleanSetup({ answer: "dog" });
	G.beginDevelop(room, player.id, setup, 0);
	G.beginReveal(room, player.id, setup, "flextok", 4300, 0);
	assert.equal(G.currentRound(room).revealAt, 4300 + G.MIN_COUNTDOWN_MS);
}
assert.ok(G.matches("Dogs", "dog") && G.matches("the coffe mug", "coffee mug") && !G.matches("cat", "car"));
assert.ok(G.matches("glasses", "glass") && !G.matches("mug", "coffee mug"));
for (const n of [2, 3, 4, 8]) {
	const s = await game({ players: ["Ann", "Bo", "Cy", "Di", "Ed", "Flo", "Gus", "Hal"].slice(0, n) });
	console.log(`${n} players: ok, winner ${s.standings[0].name} ${s.standings[0].score}, threshold ${s.threshold} B`);
}
await timeouts();
console.log("timeouts and leaving: ok");
await decoderPath();
console.log("FlexTok decoder path: ok");
