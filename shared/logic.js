// Game rules for "How Few Bytes?". Pure functions over a plain room object, so the same code
// runs in the laptop server (memory store) and the Netlify function (Blobs store). Time only
// enters through `now`, and every phase change is derived from timestamps in advance(), which
// is what lets a serverless function with no timers run the game.

export const RUNGS = [2, 4, 8, 16, 32, 64, 128, 256, 512]; // bytes; FlexTok tokens = bytes / 2
export const POINTS = [100, 90, 80, 70, 60, 50, 40, 30, 20];
export const CALL_BONUS = 25;
export const RUNG_MS = 5000;
export const COUNTDOWN_MS = 3000; // from the photo arriving, so it overlaps FlexTok's first rung
export const MIN_COUNTDOWN_MS = 1000; // once the first rung exists, so every phone has polled it
export const SHOOT_MS = 60000;
export const DEVELOP_MS = 90000;
export const ROUNDEND_MS = 15000;
export const ACTIVE_MS = 30000; // a player who hasn't polled for this long counts as away
export const GRACE_MS = 400; // guesses are judged at the rung shown this long ago (network lag)
export const MAX_ALTERNATES = 6;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

export class GameError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.status = status;
	}
}

const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O, they read as 1 and 0

export function randomId(n = 12) {
	const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
	const bytes = crypto.getRandomValues(new Uint8Array(n));
	return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}

export function randomCode() {
	const bytes = crypto.getRandomValues(new Uint8Array(4));
	return Array.from(bytes, (b) => CODE_LETTERS[b % CODE_LETTERS.length]).join("");
}

function cleanName(name) {
	const s = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 16);
	if (!s) throw new GameError("Enter a name.");
	return s;
}

function newPlayer(name, now) {
	return { id: randomId(), token: randomId(24), name: cleanName(name), joinedAt: now, lastSeen: now };
}

export function createRoom(code, hostName, now) {
	const host = newPlayer(hostName, now);
	const room = {
		code,
		createdAt: now,
		hostId: host.id,
		phase: "lobby",
		players: [host],
		order: [],
		laps: 1,
		roundIndex: 0,
		rounds: [],
		phaseEndsAt: null,
	};
	return { room, player: host };
}

export function findPlayer(room, id, token) {
	const p = room.players.find((x) => x.id === id);
	if (!p || p.token !== token) throw new GameError("You're not in this room.", 403);
	return p;
}

export function joinRoom(room, name, now) {
	if (room.phase !== "lobby") throw new GameError("This game has already started.");
	if (room.players.length >= MAX_PLAYERS) throw new GameError("This room is full (8 players).");
	const p = newPlayer(name, now);
	if (room.players.some((x) => x.name.toLowerCase() === p.name.toLowerCase()))
		throw new GameError("Someone in the room already has that name.");
	room.players.push(p);
	return p;
}

export function leaveRoom(room, playerId, now) {
	room.players = room.players.filter((p) => p.id !== playerId);
	if (room.hostId === playerId && room.players.length) room.hostId = room.players[0].id;
	if (room.phase !== "lobby" && room.phase !== "over" && room.players.length < MIN_PLAYERS) room.phase = "over";
	advance(room, now);
}

export function touch(room, player, now) {
	// Only worth a write every few seconds, so the caller skips saving when this returns false
	if (now - player.lastSeen < ACTIVE_MS / 3) return false;
	player.lastSeen = now;
	return true;
}

const isActive = (p, now) => now - p.lastSeen < ACTIVE_MS;

export function currentRound(room) {
	return room.rounds[room.roundIndex] ?? null;
}

export function totalRounds(room) {
	return room.order.length * room.laps;
}

export function startGame(room, playerId, now) {
	if (room.hostId !== playerId) throw new GameError("Only the host can start the game.", 403);
	if (room.phase !== "lobby") throw new GameError("The game has already started.");
	if (room.players.length < MIN_PLAYERS) throw new GameError("You need at least 2 players.");
	room.order = room.players.map((p) => p.id);
	room.laps = room.players.length <= 3 ? 2 : 1;
	room.rounds = [];
	room.roundIndex = -1;
	nextRound(room, now);
}

function nextRound(room, now) {
	room.roundIndex += 1;
	while (room.roundIndex < totalRounds(room)) {
		const photographerId = room.order[room.roundIndex % room.order.length];
		if (room.players.some((p) => p.id === photographerId)) {
			room.rounds[room.roundIndex] = {
				id: randomId(10),
				photographerId,
				mode: null, // "camera" (a photo through FlexTok) or "imagine" (FlexAR from a class)
				answer: null,
				answers: [], // everything accepted: the answer, alternates, class synonyms
				choices: null, // multiple choice: the answer and 3 decoys, shuffled
				call: null,
				decoder: null,
				startedAt: now,
				revealAt: null,
				endedAt: null,
				skipped: false,
				guesses: [],
			};
			room.phase = "shoot";
			room.phaseEndsAt = now + SHOOT_MS;
			return;
		}
		// The photographer for this slot has left: record a skipped round and move on
		room.rounds[room.roundIndex] = { id: randomId(10), photographerId, skipped: true, guesses: [] };
		room.roundIndex += 1;
	}
	room.phase = "over";
	room.phaseEndsAt = null;
}

function skipRound(room, now) {
	const r = currentRound(room);
	r.skipped = true;
	r.endedAt = now;
	nextRound(room, now);
}

export function rungAt(round, t) {
	if (!round?.revealAt || t < round.revealAt) return -1;
	return Math.min(RUNGS.length - 1, Math.floor((t - round.revealAt) / RUNG_MS));
}

function revealEndsAt(round) {
	return round.revealAt + RUNGS.length * RUNG_MS;
}

function guessers(room, round) {
	return room.players.filter((p) => p.id !== round.photographerId);
}

function hasCorrect(round, playerId) {
	return round.guesses.some((g) => g.playerId === playerId && g.correct);
}

// Out of guesses for this round: right already, or used their one multiple-choice pick
function isDone(round, playerId) {
	return hasCorrect(round, playerId) || (round.choices !== null && round.guesses.some((g) => g.playerId === playerId));
}

// Applies every phase change that is due by `now`. Returns true if anything changed.
export function advance(room, now) {
	let changed = false;
	for (let i = 0; i < 50; i++) {
		const r = currentRound(room);
		const photographer = r && room.players.find((p) => p.id === r.photographerId);
		if (room.phase === "shoot") {
			if (now >= room.phaseEndsAt || !photographer || !isActive(photographer, now)) {
				skipRound(room, now);
				changed = true;
				continue;
			}
		} else if (room.phase === "develop") {
			if (now >= room.phaseEndsAt) {
				skipRound(room, now);
				changed = true;
				continue;
			}
		} else if (room.phase === "reveal") {
			const waiting = guessers(room, r).filter((p) => isActive(p, now) && !isDone(r, p.id));
			if (now >= revealEndsAt(r) || (now >= r.revealAt && waiting.length === 0)) {
				r.endedAt = now;
				room.phase = "roundEnd";
				room.phaseEndsAt = now + ROUNDEND_MS;
				changed = true;
				continue;
			}
		} else if (room.phase === "roundEnd") {
			if (now >= room.phaseEndsAt) {
				nextRound(room, now);
				changed = true;
				continue;
			}
		}
		break;
	}
	return changed;
}

function requirePhotographer(room, playerId, phases) {
	const r = currentRound(room);
	if (!r || !phases.includes(room.phase)) throw new GameError("That isn't possible right now.");
	if (r.photographerId !== playerId) throw new GameError("Only this round's photographer can do that.", 403);
	return r;
}

export function cleanAnswer(answer) {
	const s = String(answer ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
	if (!s) throw new GameError("Type what your photo shows.");
	return s;
}

export function cleanCall(call) {
	if (call === null || call === undefined || call === "") return null;
	const i = Number(call);
	if (!Number.isInteger(i) || i < 0 || i >= RUNGS.length) throw new GameError("Pick a byte level for your bet.");
	return i;
}

const cleanWord = (w) => String(w ?? "").replace(/\s+/g, " ").trim().slice(0, 40);

function shuffle(xs) {
	const out = [...xs];
	const r = crypto.getRandomValues(new Uint32Array(out.length));
	for (let i = out.length - 1; i > 0; i--) {
		const j = r[i] % (i + 1);
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

// What the photographer sends with a round: the answer, other accepted answers (a comma list or
// an array), class synonyms for Imagine rounds, the bet, and optionally 3 decoys, which make it
// a multiple-choice round
export function cleanSetup(s = {}) {
	const answer = cleanAnswer(s.answer);
	const extra = Array.isArray(s.alternates) ? s.alternates : String(s.alternates ?? "").split(",");
	const answers = [];
	for (const w of [answer, ...extra.slice(0, MAX_ALTERNATES), ...(s.synonyms ?? [])].map(cleanWord)) {
		if (w && !answers.some((a) => normalize(a) === normalize(w))) answers.push(w);
	}
	let choices = null;
	const decoys = (Array.isArray(s.decoys) ? s.decoys : []).map(cleanWord).filter(Boolean);
	if (decoys.length) {
		const distinct = decoys.filter((d, i) => decoys.findIndex((x) => normalize(x) === normalize(d)) === i);
		if (distinct.length !== 3) throw new GameError("Multiple choice needs 3 different decoys.");
		if (distinct.some((d) => anyMatch(d, answers))) throw new GameError("A decoy is too close to the answer.");
		choices = shuffle([answer, ...distinct]);
	}
	return { mode: s.mode === "imagine" ? "imagine" : "camera", answer, answers, call: cleanCall(s.call), choices };
}

// The photographer has sent their round and the laptop is now developing it
export function beginDevelop(room, playerId, setup, now) {
	const r = requirePhotographer(room, playerId, ["shoot"]);
	Object.assign(r, setup);
	room.phase = "develop";
	room.phaseEndsAt = now + DEVELOP_MS;
}

// Developing failed before the first picture: back to shooting, with a little time to retry
export function cancelDevelop(room, playerId, now) {
	const r = requirePhotographer(room, playerId, ["develop"]);
	room.phase = "shoot";
	room.phaseEndsAt = Math.max(now + SHOOT_MS / 2, r.startedAt + SHOOT_MS);
}

// The first rung is stored; the countdown runs from when the round was sent (sentAt), so time
// spent developing counts toward it
export function beginReveal(room, playerId, setup, decoder, now, sentAt = now) {
	const r = requirePhotographer(room, playerId, ["shoot", "develop"]);
	Object.assign(r, setup);
	r.decoder = decoder;
	r.revealAt = Math.max(now + MIN_COUNTDOWN_MS, sentAt + COUNTDOWN_MS);
	room.phase = "reveal";
	room.phaseEndsAt = revealEndsAt(r);
}

// The rung a guess counts at: the one shown a moment ago, unless that rung's guess is spent
function guessRung(room, r, playerId, now) {
	if (room.phase !== "reveal" || !r) throw new GameError("Guessing is closed.");
	if (r.photographerId === playerId) throw new GameError("You set this picture, no guessing!");
	let rung = rungAt(r, now - GRACE_MS);
	if (rung < 0 || r.guesses.some((g) => g.playerId === playerId && g.rung === rung)) rung = rungAt(r, now);
	if (rung < 0) throw new GameError("Wait for the first picture.");
	if (hasCorrect(r, playerId)) throw new GameError("You already got it.");
	return rung;
}

// A typed guess. `verdict` is the server's meaning check (CLIP) when it has one: "match",
// "warm" (shown as Close!) or "miss"; a spelling match with any accepted answer always wins.
export function submitGuess(room, playerId, text, now, verdict = "miss") {
	const r = currentRound(room);
	const rung = guessRung(room, r, playerId, now);
	if (r.choices) throw new GameError("This round is multiple choice: pick an option.");
	if (r.guesses.some((g) => g.playerId === playerId && g.rung === rung))
		throw new GameError("One guess per byte level. Wait for more bytes.");
	const t = cleanWord(text);
	if (!t) throw new GameError("Type a guess.");
	const spelled = anyMatch(t, r.answers);
	const v = spelled ? "match" : ["match", "warm"].includes(verdict) ? verdict : "miss";
	const g = { id: randomId(8), playerId, text: t, rung, at: now, verdict: v, correct: v === "match", auto: v === "match", by: spelled ? "spelling" : v === "miss" ? null : "meaning" };
	r.guesses.push(g);
	advance(room, now);
	return g;
}

// A multiple-choice pick: one per round, so waiting for more bytes is the gamble
export function submitPick(room, playerId, choice, now) {
	const r = currentRound(room);
	const rung = guessRung(room, r, playerId, now);
	if (!r.choices) throw new GameError("This round isn't multiple choice.");
	if (r.guesses.some((g) => g.playerId === playerId)) throw new GameError("You've used your pick for this round.");
	const i = Number(choice);
	if (!Number.isInteger(i) || i < 0 || i >= r.choices.length) throw new GameError("Pick one of the options.");
	const correct = r.choices[i] === r.answer;
	const g = { id: randomId(8), playerId, text: r.choices[i], choice: i, rung, at: now, verdict: correct ? "match" : "miss", correct, auto: correct, by: "choice" };
	r.guesses.push(g);
	advance(room, now);
	return g;
}

// Photographer taps a guess to accept or reject it
export function judgeGuess(room, playerId, guessId, correct) {
	const r = requirePhotographer(room, playerId, ["reveal", "roundEnd"]);
	const g = r.guesses.find((x) => x.id === guessId);
	if (!g) throw new GameError("That guess no longer exists.");
	g.correct = !!correct;
}

export function skipWait(room, playerId, now) {
	const r = currentRound(room);
	if (room.phase !== "roundEnd") return;
	if (playerId !== room.hostId && playerId !== r?.photographerId)
		throw new GameError("Only the host or the photographer can skip ahead.", 403);
	nextRound(room, now);
}

export function playAgain(room, playerId) {
	if (room.hostId !== playerId) throw new GameError("Only the host can restart.", 403);
	if (room.phase !== "over") throw new GameError("The game isn't over yet.");
	room.phase = "lobby";
	room.rounds = [];
	room.order = [];
	room.roundIndex = 0;
	room.phaseEndsAt = null;
}

// ---- Matching -------------------------------------------------------------------------------

const STOP = new Set(["a", "an", "the", "some", "my", "of"]);

function singular(w) {
	if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
	if (w.length > 4 && /(ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
	if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
	return w;
}

export function normalize(s) {
	return String(s)
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.split(" ")
		.filter((w) => w && !STOP.has(w))
		.map(singular)
		.join(" ");
}

function levenshtein(a, b) {
	const d = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		let prev = d[0];
		d[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = d[j];
			d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = tmp;
		}
	}
	return d[b.length];
}

// Auto-accepts exact answers, plurals and small typos; meaning is the server's job (CLIP)
export function matches(guess, answer) {
	const g = normalize(guess).replace(/ /g, "");
	const a = normalize(answer).replace(/ /g, "");
	if (!g || !a) return false;
	if (g === a) return true;
	const allowed = a.length >= 8 ? 2 : a.length >= 4 ? 1 : 0;
	return levenshtein(g, a) <= allowed;
}

export function anyMatch(guess, answers) {
	return answers.some((a) => matches(guess, a));
}

// ---- Scoring --------------------------------------------------------------------------------

// Points each player earned in one round, plus who was first and whether the bet paid off
export function scoreRound(round) {
	const pts = {};
	if (!round || round.skipped || !round.revealAt) return { pts, firstRung: null, callHit: false };
	const best = {};
	for (const g of round.guesses) {
		if (!g.correct) continue;
		if (best[g.playerId] === undefined || g.rung < best[g.playerId]) best[g.playerId] = g.rung;
	}
	let top = 0;
	let firstRung = null;
	for (const [pid, rung] of Object.entries(best)) {
		pts[pid] = POINTS[rung];
		top = Math.max(top, POINTS[rung]);
		firstRung = firstRung === null ? rung : Math.min(firstRung, rung);
	}
	const callHit = round.call !== null && firstRung !== null && round.call === firstRung;
	pts[round.photographerId] = Math.round(top / 2) + (callHit ? CALL_BONUS : 0);
	return { pts, best, firstRung, callHit };
}

export function standings(room) {
	const rows = room.players.map((p) => ({ id: p.id, name: p.name, score: 0, bytes: [] }));
	const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
	for (const round of room.rounds) {
		if (!round || round.endedAt === null || round.skipped) continue;
		const { pts, best } = scoreRound(round);
		for (const [pid, v] of Object.entries(pts)) if (byId[pid]) byId[pid].score += v;
		for (const [pid, rung] of Object.entries(best ?? {})) if (byId[pid]) byId[pid].bytes.push(RUNGS[rung]);
	}
	for (const r of rows) {
		r.avgBytes = r.bytes.length ? r.bytes.reduce((a, b) => a + b, 0) / r.bytes.length : null;
		delete r.bytes;
	}
	// Ties go to whoever needed fewer bytes on average
	rows.sort((a, b) => b.score - a.score || (a.avgBytes ?? Infinity) - (b.avgBytes ?? Infinity));
	return rows;
}

// The room's "semantic threshold": average bytes at which each photo was first recognised
export function semanticThreshold(room) {
	const firsts = room.rounds
		.filter((r) => r && r.endedAt && !r.skipped)
		.map((r) => scoreRound(r).firstRung)
		.filter((x) => x !== null)
		.map((i) => RUNGS[i]);
	return firsts.length ? Math.round(firsts.reduce((a, b) => a + b, 0) / firsts.length) : null;
}

// ---- What each player is allowed to see ------------------------------------------------------

export function canSeeImage(room, playerId, roundId, rung, now) {
	const idx = room.rounds.findIndex((r) => r?.id === roundId);
	if (idx === -1) return false;
	const r = room.rounds[idx];
	if (r.photographerId === playerId) return true;
	if (idx < room.roundIndex || r.endedAt !== null || room.phase === "over") return true;
	if (rung === "photo") return false;
	return Number(rung) <= rungAt(r, now);
}

export function view(room, playerId, now) {
	const me = room.players.find((p) => p.id === playerId);
	const r = currentRound(room);
	const scores = Object.fromEntries(standings(room).map((s) => [s.id, s.score]));
	const out = {
		code: room.code,
		now,
		phase: room.phase,
		phaseEndsAt: room.phaseEndsAt,
		hostId: room.hostId,
		you: { id: me.id, name: me.name, isHost: room.hostId === me.id },
		players: room.players.map((p) => ({
			id: p.id,
			name: p.name,
			score: scores[p.id] ?? 0,
			active: isActive(p, now),
		})),
		roundNumber: room.phase === "lobby" ? 0 : Math.min(room.roundIndex + 1, totalRounds(room)),
		totalRounds: totalRounds(room),
		laps: room.laps,
		round: null,
	};
	if (r && ["shoot", "develop", "reveal", "roundEnd"].includes(room.phase)) out.round = roundView(room, r, me, now);
	if (room.phase === "over") {
		out.standings = standings(room);
		out.threshold = semanticThreshold(room);
		out.history = room.rounds
			.filter((x) => x && !x.skipped && x.endedAt)
			.map((x) => {
				const s = scoreRound(x);
				return {
					id: x.id,
					mode: x.mode,
					photographer: nameOf(room, x.photographerId),
					answer: x.answer,
					firstBytes: s.firstRung === null ? null : RUNGS[s.firstRung],
				};
			});
	}
	return out;
}

function nameOf(room, id) {
	return room.players.find((p) => p.id === id)?.name ?? "(left)";
}

function roundView(room, r, me, now) {
	const isPhotographer = r.photographerId === me.id;
	const ended = room.phase === "roundEnd";
	const rung = rungAt(r, now);
	const v = {
		id: r.id,
		photographerId: r.photographerId,
		photographer: nameOf(room, r.photographerId),
		isPhotographer,
		mode: r.mode,
		decoder: r.decoder,
		choices: r.choices,
		revealAt: r.revealAt,
		rung,
		rungMs: RUNG_MS,
		answer: isPhotographer || ended ? r.answer : null,
		alsoAccepted: isPhotographer || ended ? r.answers.filter((a) => a !== r.answer) : null,
		call: isPhotographer || ended ? r.call : null,
		myGuesses: r.guesses
			.filter((g) => g.playerId === me.id)
			.map((g) => ({ text: g.text, rung: g.rung, correct: g.correct, verdict: g.verdict, choice: g.choice ?? null })),
		// Everyone sees who got it and at which rung, but not the words, until the round ends
		solved: Object.entries(scoreRound(r).best ?? {}).map(([pid, rg]) => ({ name: nameOf(room, pid), rung: rg, id: pid })),
	};
	if (isPhotographer || ended) {
		v.guesses = r.guesses.map((g) => ({
			id: g.id,
			name: nameOf(room, g.playerId),
			text: g.text,
			rung: g.rung,
			correct: g.correct,
			auto: g.auto,
			verdict: g.verdict,
			by: g.by ?? null,
		}));
	}
	if (ended) {
		const s = scoreRound(r);
		v.roundPoints = room.players
			.map((p) => ({ name: p.name, pts: s.pts[p.id] ?? 0, isPhotographer: p.id === r.photographerId }))
			.filter((x) => x.pts > 0 || x.isPhotographer);
		v.firstRung = s.firstRung;
		v.callHit = s.callHit;
	}
	return v;
}
