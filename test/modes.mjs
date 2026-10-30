// Imagine rounds, alternate answers, meaning-judged guesses and multiple choice, against the
// shared handler with a fake clock and mock models:
//   node test/modes.mjs
import assert from "node:assert/strict";
import { handle } from "../shared/handler.js";
import { memoryStore } from "../shared/memory-store.js";
import * as G from "../shared/logic.js";

const JPEG = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
const PNG = (n) => Uint8Array.from([0x89, 0x50, n]);
let now = 5_000_000;

async function room(ctxExtra = {}, names = ["Ann", "Bo", "Cy"]) {
	const store = memoryStore();
	const call = (params) => handle({ params }, { store, now, ...ctxExtra });
	const ids = [(await call({ action: "create", name: names[0] })).json];
	for (const n of names.slice(1)) ids.push((await call({ action: "join", code: ids[0].code, name: n })).json);
	const as = (i, params) => call({ ...params, code: ids[0].code, pid: ids[i].pid, token: ids[i].token });
	assert.equal((await as(0, { action: "start" })).status, 200);
	return { as, call, state: async (i) => (await as(i, { action: "state" })).json };
}

const reveal = async (g) => {
	now += G.COUNTDOWN_MS + 100;
	await Promise.all([0, 1, 2].map((i) => g.state(i)));
};

// ---- Alternate answers and meaning (CLIP) judging -------------------------------------------
{
	const judged = [];
	const judge = async (image, answers, guess) => {
		judged.push({ image: image.length, answers, guess });
		return { verdict: { doggo: "match", animal: "warm" }[guess] ?? "miss" };
	};
	const g = await room({ judge });
	assert.equal((await g.call({ action: "info" })).json.judge, true);
	const r = await g.as(0, { action: "photo", photo: JPEG, ladder: Array(9).fill(JPEG), answer: "dog", alternates: "puppy, hound , dog" });
	assert.equal(r.status, 200, JSON.stringify(r.json));
	let s = await g.state(0);
	assert.deepEqual(s.round.alsoAccepted, ["puppy", "hound"], "alternates kept, duplicate of the answer dropped");
	assert.equal((await g.state(1)).round.alsoAccepted, null, "alternates hidden from guessers");
	await reveal(g);

	assert.equal((await g.as(1, { action: "guess", text: "animal" })).status, 200);
	s = await g.state(1);
	assert.equal(s.round.myGuesses[0].verdict, "warm", "near miss is Close!");
	assert.equal(s.round.myGuesses[0].correct, false);
	assert.deepEqual(judged.at(-1), { image: 4, answers: ["dog", "puppy", "hound"], guess: "animal" }, "judged against the photo and every answer");

	const before = judged.length;
	assert.equal((await g.as(2, { action: "guess", text: "Puppies" })).status, 200);
	assert.equal(judged.length, before, "a spelling match never calls CLIP");
	assert.ok((await g.state(2)).round.myGuesses[0].correct, "alternate answer accepted");

	now += G.RUNG_MS;
	assert.equal((await g.as(1, { action: "guess", text: "doggo" })).status, 200);
	s = await g.state(0);
	assert.equal(s.phase, "roundEnd", "everyone right ends the round");
	const pts = Object.fromEntries(s.round.roundPoints.map((x) => [x.name, x.pts]));
	assert.deepEqual(pts, { Ann: 50, Bo: 90, Cy: 100 }, "meaning match scores at its rung; photographer gets half the best");
	assert.equal(s.round.guesses.find((x) => x.text === "doggo").by, "meaning");

	// A judge that's down doesn't block guessing
	const g2 = await room({ judge: async () => { throw new Error("CLIP fell over"); } });
	await g2.as(0, { action: "photo", photo: JPEG, ladder: Array(9).fill(JPEG), answer: "cat" });
	await reveal(g2);
	assert.equal((await g2.as(1, { action: "guess", text: "kitten" })).status, 200);
	assert.equal((await g2.state(1)).round.myGuesses[0].verdict, "miss");
	console.log("alternates + meaning judging: ok");
}

// ---- Multiple choice ------------------------------------------------------------------------
{
	const g = await room();
	const bad = await g.as(0, { action: "photo", photo: JPEG, ladder: Array(9).fill(JPEG), answer: "apple", decoys: ["pear", "plum"] });
	assert.equal(bad.status, 400, "needs exactly 3 decoys");
	const close = await g.as(0, { action: "photo", photo: JPEG, ladder: Array(9).fill(JPEG), answer: "apple", decoys: ["pear", "plum", "Apples"] });
	assert.match(close.json.error, /too close/);
	const ok = await g.as(0, { action: "photo", photo: JPEG, ladder: Array(9).fill(JPEG), answer: "apple", decoys: ["pear", "plum", "peach"], call: 2 });
	assert.equal(ok.status, 200, JSON.stringify(ok.json));
	let s = await g.state(1);
	assert.deepEqual([...s.round.choices].sort(), ["apple", "peach", "pear", "plum"], "guessers see all 4 options");
	assert.equal(s.round.answer, null);
	await reveal(g);
	assert.equal((await g.as(1, { action: "guess", text: "apple" })).status, 400, "no typing in a multiple-choice round");

	const wrong = s.round.choices.findIndex((c) => c !== "apple");
	assert.equal((await g.as(1, { action: "pick", choice: wrong })).status, 200);
	assert.equal((await g.as(1, { action: "pick", choice: s.round.choices.indexOf("apple") })).status, 400, "one pick per round");
	now += 2 * G.RUNG_MS + G.GRACE_MS; // well into rung 2: 8 B
	assert.equal((await g.as(2, { action: "pick", choice: s.round.choices.indexOf("apple") })).status, 200);
	s = await g.state(0);
	assert.equal(s.phase, "roundEnd", "everyone has picked");
	const pts = Object.fromEntries(s.round.roundPoints.map((x) => [x.name, x.pts]));
	assert.deepEqual(pts, { Ann: 65, Cy: 80 }, "wrong pick 0; right pick at 8 B; photographer 40 + 25 for the bet");
	console.log("multiple choice: ok");
}

// ---- Imagine rounds (FlexAR) ----------------------------------------------------------------
{
	const classes = [["tench", ["Tinca tinca"]], ["goldfish", ["Carassius auratus"]], ["Golden Retriever", []]];
	const prepared = [];
	let failAt = 6; // the mock FlexAR stops after rung 5
	const imagine = {
		prepare: async (label, replaces) => {
			prepared.push({ label, replaces });
			return `job${prepared.length}`;
		},
		ladder: async (job, onImage) => {
			for (let i = 0; i < 9; i++) {
				if (i === failAt) throw new Error("MPS out of memory");
				now += 100;
				await onImage(i, PNG(i));
			}
		},
	};
	const ctx = { imagine, classes, decoder: async () => {}, decoderName: "flextok" };
	const g = await room(ctx);
	assert.equal((await g.call({ action: "info" })).json.imagine, true);
	assert.equal((await g.as(1, { action: "prepare", label: 1 })).status, 403, "only the photographer prepares");
	assert.equal((await g.as(0, { action: "prepare", label: 1000 })).status, 400);
	const p1 = (await g.as(0, { action: "prepare", label: 2 })).json.job;
	const p2 = (await g.as(0, { action: "prepare", label: 1, replaces: p1 })).json.job;
	assert.deepEqual(prepared.at(-1), { label: 1, replaces: "job1" }, "changing class replaces the old job");

	const r = await g.as(0, { action: "photo", mode: "imagine", label: 1, job: p2, answer: "ignored", alternates: "fish" });
	assert.equal(r.status, 200, JSON.stringify(r.json));
	assert.equal(r.json.decoder, "flexar");
	let s = await g.state(0);
	assert.equal(s.round.answer, "goldfish", "the class is the answer");
	assert.deepEqual(s.round.alsoAccepted, ["fish", "Carassius auratus"]);
	assert.equal(s.round.mode, "imagine");
	await reveal(g);
	assert.equal((await g.as(1, { action: "guess", text: "carassius auratus" })).status, 200);
	assert.ok((await g.state(1)).round.myGuesses[0].correct, "class synonyms accepted");

	now += 8 * G.RUNG_MS;
	s = await g.state(1);
	const img8 = await g.as(1, { action: "img", round: s.round.id, rung: 8 });
	assert.equal(img8.bytes[2], 5, "rungs FlexAR never reached repeat the last one it did");
	const photo = await g.as(0, { action: "img", round: s.round.id, rung: "photo" });
	assert.equal(photo.bytes[2], 5, "the sharpest rung stands in for the original");

	// FlexAR fails before the first picture: back to shooting, not a stuck round
	now += G.ROUNDEND_MS + 1;
	s = await g.state(1);
	assert.equal(s.round.photographerId, s.you.id, "Bo shoots next");
	failAt = 0;
	const fail = await g.as(1, { action: "photo", mode: "imagine", label: 0 });
	assert.equal(fail.status, 503);
	s = await g.state(1);
	assert.equal(s.phase, "shoot", "the photographer can try again");
	assert.ok(s.phaseEndsAt - now >= G.SHOOT_MS / 2 - 1000);

	// Netlify has no FlexAR: Imagine is refused, camera still works
	const n = await room({});
	assert.equal((await n.call({ action: "info" })).json.imagine, false);
	assert.equal((await n.as(0, { action: "photo", mode: "imagine", label: 1 })).status, 400);
	assert.equal((await n.as(0, { action: "photo", photo: JPEG, ladder: Array(9).fill(JPEG), answer: "x" })).status, 200);
	console.log("imagine rounds: ok");
}
