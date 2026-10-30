// Phone client for "How Few Bytes?". Polls the game API once a second and redraws the screen in
// named sections, replacing only the sections whose HTML changed, so text boxes, the camera and
// the picture keep their state between polls. Anything that moves with the clock (timers, the
// current rung of the picture) is updated by tick() five times a second instead.
import { standinLadder, describe, RUNGS } from "./standin.js";

const API = "/.netlify/functions/game";
const POINTS = [100, 90, 80, 70, 60, 50, 40, 30, 20];
const POLL_MS = 1000;
const app = document.getElementById("app");

// Per tab, so two tabs in one browser can be two players; the name is remembered across tabs
let session = loadJSON("hfb-session", sessionStorage); // { code, pid, token }
let state = null; // the last view the server sent
let info = { decoder: "standin" };
let offset = 0; // server clock minus ours
let shot = null; // the photographer's capture: { roundId, photo, ladder }
let bet = null; // the photographer's "call it" rung
let mode = "camera"; // "camera" or "imagine" (FlexAR, host laptop only)
let classes = null; // [[name, [synonyms]], ...] by ImageNet label, loaded when Imagine is available
let chosen = null; // the Imagine pick: { label, name, synonyms, job }
let camStream = null;
let busy = false;
let pollTimer = null;
let mounted = { screen: null, keys: "", html: {} };

// ---- Storage and API ------------------------------------------------------------------------

function loadJSON(key, where = localStorage) {
	try {
		return JSON.parse(where.getItem(key) ?? "null");
	} catch {
		return null;
	}
}

function saveJSON(key, value, where = localStorage) {
	try {
		if (value === null) where.removeItem(key);
		else where.setItem(key, JSON.stringify(value));
	} catch {
		// private mode: the game still works, it just won't survive a reload
	}
}

function setSession(s) {
	session = s;
	saveJSON("hfb-session", s, sessionStorage);
	if (!s) state = null;
}

async function api(action, params = {}) {
	const base = { action, ...(session && { code: session.code, pid: session.pid, token: session.token }), ...params };
	const res =
		action === "state" || action === "info"
			? await fetch(`${API}?${new URLSearchParams(base)}`, { cache: "no-store" })
			: await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(base) });
	const json = await res.json().catch(() => ({ error: "Couldn't reach the game server." }));
	if (!res.ok) throw Object.assign(new Error(json.error ?? "Something went wrong."), { status: res.status });
	return json;
}

function imgUrl(roundId, rung) {
	return `${API}?${new URLSearchParams({ action: "img", code: session.code, pid: session.pid, token: session.token, round: roundId, rung })}`;
}

const serverNow = () => Date.now() + offset;

// One poll loop only: a poll asked for while another is in flight runs right after it
let polling = false;
let pollAgain = false;

async function poll() {
	clearTimeout(pollTimer);
	if (polling) {
		pollAgain = true;
		return;
	}
	polling = true;
	if (session) {
		try {
			const t0 = Date.now();
			const s = await api("state");
			offset = s.now - (t0 + Date.now()) / 2;
			state = s;
		} catch (e) {
			if (e.status === 403 || e.status === 404) {
				toast(e.status === 404 ? "That room has closed." : e.message);
				setSession(null);
			}
		}
	}
	try {
		render();
	} finally {
		polling = false;
		if (pollAgain) {
			pollAgain = false;
			setTimeout(poll, 0);
		} else pollTimer = setTimeout(poll, POLL_MS);
	}
}

async function run(fn) {
	if (busy) return;
	busy = true;
	tick();
	try {
		await fn();
	} catch (e) {
		toast(e.message);
	} finally {
		busy = false;
		poll();
	}
}

// ---- Rendering ------------------------------------------------------------------------------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const bytesLabel = (i) => `${RUNGS[i]} B`;

function patch(screen, sections) {
	const keys = sections.map((s) => s[0]).join(",");
	if (mounted.screen !== screen || mounted.keys !== keys) {
		const changedScreen = mounted.screen !== screen;
		app.innerHTML = sections.map(([k, h]) => `<section data-sec="${k}">${h}</section>`).join("");
		mounted = { screen, keys, html: Object.fromEntries(sections) };
		if (changedScreen) {
			window.scrollTo(0, 0);
			onMount(screen);
		}
		return;
	}
	for (const [k, h] of sections) {
		if (mounted.html[k] === h) continue;
		app.querySelector(`[data-sec="${k}"]`).innerHTML = h;
		mounted.html[k] = h;
	}
}

function render() {
	const s = state;
	let screen, sections;
	if (!session || !s) [screen, sections] = ["home", homeScreen()];
	else if (s.phase === "lobby") [screen, sections] = ["lobby", lobbyScreen(s)];
	else if (s.phase === "shoot" && s.round.isPhotographer) [screen, sections] = [`shoot-me:${s.round.id}`, shootMeScreen(s)];
	else if (s.phase === "shoot") [screen, sections] = ["shoot-wait", shootWaitScreen(s)];
	else if (s.phase === "develop") [screen, sections] = ["develop", developScreen(s)];
	else if (s.phase === "reveal") [screen, sections] = [`reveal:${s.round.id}`, revealScreen(s)];
	else if (s.phase === "roundEnd") [screen, sections] = [`end:${s.round.id}`, roundEndScreen(s)];
	else [screen, sections] = ["over", overScreen(s)];
	patch(screen, sections);
	if (!screen.startsWith("shoot-me")) stopCamera();
	if (screen.startsWith("shoot-me")) updateShootControls();
	tick();
}

const HOWTO = `
<details class="howto" open>
	<summary>How to play</summary>
	<ol>
		<li><b>Shoot.</b> Each round one player is the photographer. They photograph something nearby, or (with FlexAR on the host laptop) pick a thing for the AI to <b>imagine</b>. They secretly type what it is, plus any other answers they'd accept, and can turn the round into <b>multiple choice</b> by adding 3 decoys.</li>
		<li><b>Develop.</b> The picture is cut down to a few bytes and developed back. Everyone else watches it sharpen: 2 bytes, 4, 8, 16 … up to 512, a new level every 5 seconds.</li>
		<li><b>Guess.</b> Type what you think it is: one guess per level, wrong guesses cost nothing, and a near miss shows <b>Close!</b> (the host laptop judges meaning, so "puppy" counts for "dog"). In a multiple-choice round you get <b>one</b> tap for the whole round, so waiting for more bytes is the gamble.</li>
		<li><b>Score.</b> The fewer bytes you needed, the more you get: 100 points at 2 bytes, down to 20 at 512.</li>
		<li><b>Photographer.</b> Earns half the best guesser's points, plus 25 for betting on the exact level where someone first gets it.</li>
		<li><b>Winning.</b> Everyone shoots once (twice with 2–3 players). Most points wins; ties go to whoever needed fewer bytes.</li>
	</ol>
</details>`;

function header(s) {
	const me = s.players.find((p) => p.id === s.you.id);
	const round = s.totalRounds && s.phase !== "lobby" ? `<span>Round ${s.roundNumber}/${s.totalRounds}</span>` : `<span>Lobby</span>`;
	return `<div class="bar"><span class="room">Room <b>${esc(s.code)}</b></span>${round}<span class="me">${esc(me?.name)} · <b>${me?.score ?? 0}</b> pts</span></div>`;
}

function scores(s, title = "Scores") {
	const rows = [...s.players].sort((a, b) => b.score - a.score);
	return `<h3>${title}</h3><ol class="scores">${rows
		.map((p) => `<li class="${p.id === s.you.id ? "you" : ""}"><span>${esc(p.name)}${p.active ? "" : ' <i class="away">away</i>'}</span><b>${p.score}</b></li>`)
		.join("")}</ol>`;
}

function decoderNote(d) {
	if (d === "flexar")
		return `<p class="decoder flextok">Imagined by <b>FlexAR</b> on the host laptop: it wrote the 256 tokens itself and FlexTok developed the first 1, 2, 4 … 256 of them.</p>`;
	return d === "flextok"
		? `<p class="decoder flextok">Developed by <b>FlexTok</b> on the host laptop: ${RUNGS.length} prefixes of one token list, 2 bytes per token.</p>`
		: `<p class="decoder">Stand-in decoder: <b>equal-byte down-sampling</b>, the classical baseline FlexTok has to beat.</p>`;
}

function verdictTag(g) {
	if (g.by === "meaning") return ' <i class="tagchip ok">meaning</i>';
	if (g.verdict === "warm") return ' <i class="tagchip warm">close!</i>';
	return "";
}

function homeScreen() {
	const name = loadJSON("hfb-name") ?? "";
	const code = new URLSearchParams(location.search).get("room") ?? "";
	const live = [info.decoder === "flextok" && "FlexTok", info.imagine && "FlexAR", info.judge && "CLIP"].filter(Boolean);
	const badge = live.length ? `<span class="badge live">● ${live.join(" + ")} live on the host laptop</span>` : `<span class="badge">Stand-in decoder (no FlexTok on this server)</span>`;
	return [
		[
			"hero",
			`<div class="hero"><p class="kicker">Semantic Camera · party game</p><h1>How Few<br>Bytes?</h1>
			<p class="tag">One of you photographs something. Everyone else names it from as few bytes as possible.</p>${badge}</div>`,
		],
		[
			"forms",
			`<label class="field">Your name<input id="name" maxlength="16" autocomplete="nickname" placeholder="e.g. Sam" value="${esc(name)}"></label>
			<div class="cards">
				<form class="card" data-form="join"><h2>Join a room</h2>
					<label class="field">Room code<input id="code" maxlength="4" autocapitalize="characters" autocomplete="off" placeholder="ABCD" value="${esc(code)}" class="mono"></label>
					<button class="primary">Join</button></form>
				<form class="card" data-form="create"><h2>New room</h2><p class="muted">Start a room and share its code with 1–7 friends.</p>
					<button>Create room</button></form>
			</div>`,
		],
		["howto", HOWTO],
	];
}

function lobbyScreen(s) {
	const link = `${location.origin}${location.pathname}?room=${s.code}`;
	const host = s.players.find((p) => p.id === s.hostId);
	const n = s.players.length;
	const start = s.you.isHost
		? `<button class="primary big" data-act="start" ${n < 2 ? "disabled" : ""}>${n < 2 ? "Waiting for at least 1 more player" : `Start game · ${n} players`}</button>
		   <p class="muted center">${n <= 3 ? "With 2–3 players everyone shoots twice." : "Everyone shoots once."}</p>`
		: `<p class="waiting">Waiting for ${esc(host?.name)} to start…</p>`;
	return [
		["top", header(s)],
		[
			"code",
			`<div class="codebox"><p class="kicker">Room code</p><div class="bigcode mono">${esc(s.code)}</div>
			<div class="share"><input readonly value="${esc(link)}" id="link"><button data-act="copy">Copy link</button></div></div>`,
		],
		[
			"players",
			`<h3>Players <span class="muted">${n}/8</span></h3><ul class="players">${s.players
				.map((p) => `<li>${esc(p.name)}${p.id === s.hostId ? ' <i class="tagchip">host</i>' : ""}${p.id === s.you.id ? ' <i class="tagchip you">you</i>' : ""}${p.active ? "" : ' <i class="away">away</i>'}</li>`)
				.join("")}</ul>`,
		],
		["start", start],
		["howto", HOWTO],
		["leave", `<button class="ghost" data-act="leave">Leave room</button>`],
	];
}

function shootMeScreen(s) {
	const chips = [`<button type="button" class="chip" data-act="bet" data-i="">No bet</button>`]
		.concat(RUNGS.map((b, i) => `<button type="button" class="chip mono" data-act="bet" data-i="${i}">${b} B</button>`))
		.join("");
	const tabs = info.imagine
		? `<div class="tabs"><button type="button" class="tab" data-act="mode" data-mode="camera">📷 Camera</button><button type="button" class="tab" data-act="mode" data-mode="imagine">✨ Imagine</button></div>`
		: "";
	return [
		["top", header(s)],
		["title", `<div class="title"><h2>Your turn</h2><span class="timer mono" data-until="${s.phaseEndsAt}"></span></div>${tabs}
			<p class="muted" id="modeHint"></p>`],
		[
			"cam",
			`<div class="viewfinder"><video id="video" playsinline muted autoplay hidden></video><img id="preview" alt="Your photo" hidden>
				<div id="camEmpty" class="cam-empty">No photo yet</div></div>
			<div class="row">
				<button type="button" class="primary" data-act="shutter" id="shutterBtn" hidden>Take photo</button>
				<label class="btn" id="pickLabel"><span id="pickText">Take or choose a photo</span><input type="file" accept="image/*" capture="environment" id="file" hidden></label>
				<button type="button" data-act="retake" id="retakeBtn" hidden>Retake</button>
			</div>`,
		],
		[
			"imagine",
			`<label class="field">What should FlexAR imagine? <span class="muted">(one of the 1000 ImageNet things)</span>
				<input id="classq" autocomplete="off" placeholder="Search: goldfish, pizza, sports car…"></label>
			<div id="classList" class="classlist"></div>
			<div id="classPick" class="yours" hidden></div>`,
		],
		[
			"form",
			`<form data-form="photo">
				<label class="field" id="answerField">What is it? <span class="muted">(only you see this)</span><input id="answer" maxlength="40" autocomplete="off" placeholder="e.g. coffee mug"></label>
				<label class="field">Also accept <span class="muted">(optional, comma-separated)</span><input id="alternates" maxlength="120" autocomplete="off" placeholder="e.g. mug, cup, coffee cup"></label>
				<label class="check"><input type="checkbox" id="mcToggle"> <span><b>Multiple choice</b> <span class="muted">· guessers tap one of 4 options, one pick each</span></span></label>
				<div id="decoys" class="decoys" hidden>
					<input id="decoy1" maxlength="40" autocomplete="off" placeholder="Decoy 1, e.g. teapot">
					<input id="decoy2" maxlength="40" autocomplete="off" placeholder="Decoy 2">
					<input id="decoy3" maxlength="40" autocomplete="off" placeholder="Decoy 3">
				</div>
				<p class="field-label">Call it: at how many bytes will someone first get it? <span class="muted">+25 if you're exactly right</span></p>
				<div class="chips">${chips}</div>
				<button class="primary big" id="sendBtn">Send it</button>
			</form>`,
		],
	];
}

function shootWaitScreen(s) {
	return [
		["top", header(s)],
		[
			"wait",
			`<div class="center-block"><div class="shutter-anim"></div><h2>${esc(s.round.photographer)} is ${info.imagine ? "setting up a picture" : "taking a photo"}</h2>
			<p class="muted">Time left <span class="mono" data-until="${s.phaseEndsAt}"></span>. Get ready: the picture starts at just 2 bytes.</p></div>`,
		],
		["scores", scores(s)],
	];
}

function developScreen(s) {
	return [
		["top", header(s)],
		[
			"wait",
			`<div class="center-block"><div class="develop-anim"></div><h2>${s.round.mode === "imagine" ? "Imagining…" : "Developing…"}</h2>
			<p class="muted">${s.round.mode === "imagine" ? "FlexAR on the host laptop is writing the picture's tokens from scratch." : `${esc(s.round.photographer)}'s photo is being encoded into FlexTok tokens on the host laptop.`} The picture starts as soon as the first 2 bytes are developed.</p></div>`,
		],
		["scores", scores(s)],
	];
}

function picBlock(r) {
	const segs = RUNGS.map((b, i) => `<span class="seg" data-i="${i}"><b>${b}</b></span>`).join("");
	return `<div class="pic"><img id="pic" alt="The picture so far"><div class="count mono" id="count"></div></div>
		<div class="meter" id="meter">${segs}</div>
		<div class="picinfo"><b id="bytes" class="mono"></b><span id="detail" class="muted"></span><span id="nextIn" class="muted"></span></div>
		${decoderNote(r.decoder)}`;
}

function solvedFeed(r) {
	if (!r.solved.length) return `<p class="muted center">Nobody has it yet.</p>`;
	return `<ul class="feed">${r.solved
		.sort((a, b) => a.rung - b.rung)
		.map((x) => `<li>✓ <b>${esc(x.name)}</b> got it at <span class="mono">${bytesLabel(x.rung)}</span></li>`)
		.join("")}</ul>`;
}

function revealScreen(s) {
	const r = s.round;
	if (r.isPhotographer) {
		const list = r.guesses.length
			? `<ul class="judge">${r.guesses
					.slice()
					.reverse()
					.map((g) => judgeRow(g))
					.join("")}</ul>`
			: `<p class="muted center">Guesses will appear here. Tap ✓ to accept a close one.</p>`;
		return [
			["top", header(s)],
			["pic", picBlock(r)],
			["answer", `<p class="yours">${r.mode === "imagine" ? "Imagining" : "Your answer"}: <b>${esc(r.answer)}</b>${r.alsoAccepted?.length ? ` · also ${r.alsoAccepted.map(esc).join(", ")}` : ""} · Bet: <b class="mono">${r.call === null ? "none" : bytesLabel(r.call)}</b>${r.choices ? ` · <b>multiple choice</b>` : ""}</p>`],
			["judge", `<h3>Live guesses</h3>${list}`],
		];
	}
	const mine = r.myGuesses.length
		? `<ul class="mine">${r.myGuesses.map((g) => `<li class="${g.correct ? "ok" : g.verdict === "warm" ? "warm" : ""}"><span class="mono">${bytesLabel(g.rung)}</span> ${esc(g.text)} ${g.correct ? `✓ +${POINTS[g.rung]}` : g.verdict === "warm" ? "· Close!" : ""}</li>`).join("")}</ul>`
		: "";
	const guess = r.choices
		? `<div class="choices">${r.choices.map((c, i) => `<button type="button" class="choice" data-act="pick" data-i="${i}">${esc(c)}</button>`).join("")}</div>
			<p id="guessStatus" class="muted center"></p>`
		: `<form data-form="guess" class="guessrow"><input id="guess" maxlength="40" autocomplete="off" autocapitalize="off" placeholder="What is it?" enterkeyhint="send"><button class="primary" id="guessBtn">Guess</button></form>
			<p id="guessStatus" class="muted center"></p>`;
	return [
		["top", header(s)],
		["pic", picBlock(r)],
		["guess", guess],
		["mine", mine],
		["solved", `<h3>${esc(r.photographer)}'s photo</h3>${solvedFeed(r)}`],
	];
}

function judgeRow(g, canJudge = true) {
	const btn = canJudge
		? `<button class="tiny ${g.correct ? "on" : ""}" data-act="judge" data-id="${g.id}" data-correct="${g.correct ? "" : "1"}">${g.correct ? "✓ Right" : "Accept"}</button>`
		: g.correct ? "✓" : "";
	return `<li class="${g.correct ? "ok" : ""}"><span class="mono">${bytesLabel(g.rung)}</span><b>${esc(g.name)}</b><span class="gtext">${esc(g.text)}${verdictTag(g)}</span>${btn}</li>`;
}

function roundEndScreen(s) {
	const r = s.round;
	const first = r.solved.slice().sort((a, b) => a.rung - b.rung)[0];
	const firstLine = first
		? `First recognised at <b class="mono">${bytesLabel(first.rung)}</b>${r.decoder !== "standin" ? ` (${RUNGS[first.rung] / 2} token${first.rung ? "s" : ""})` : ""} by <b>${esc(first.name)}</b>`
		: "Nobody got it, even at 512 bytes.";
	const betLine = r.call === null ? "" : `<p class="muted">${esc(r.photographer)} bet on ${bytesLabel(r.call)}: ${r.callHit ? "<b>spot on, +25!</b>" : "missed."}</p>`;
	const strip = RUNGS.map((b, i) => `<figure><img loading="lazy" onerror="retryImg(this)" src="${imgUrl(r.id, i)}" alt="${b} bytes"><figcaption class="mono">${b} B</figcaption></figure>`).join("");
	const isLast = s.roundNumber >= s.totalRounds;
	const canNext = s.you.isHost || r.isPhotographer;
	return [
		["top", header(s)],
		[
			"result",
			`<p class="kicker">${esc(r.photographer)} ${r.mode === "imagine" ? "had FlexAR imagine" : "photographed"}</p><h2 class="answer">${esc(r.answer)}</h2>${r.alsoAccepted?.length ? `<p class="muted">Also accepted: ${r.alsoAccepted.map(esc).join(", ")}</p>` : ""}<p>${firstLine}</p>${betLine}`,
		],
		[
			"strip",
			`<div class="compare"><figure><img onerror="retryImg(this)" src="${imgUrl(r.id, "photo")}" alt="Original photo"><figcaption>${r.mode === "imagine" ? "Full picture (512 B)" : "Original photo"}</figcaption></figure>
			<figure><img onerror="retryImg(this)" src="${imgUrl(r.id, first ? first.rung : 8)}" alt=""><figcaption class="mono">${first ? `${bytesLabel(first.rung)}: what they saw` : "512 B"}</figcaption></figure></div>
			<div class="strip">${strip}</div>${decoderNote(r.decoder)}`,
		],
		[
			"points",
			`<h3>This round</h3><ul class="points">${r.roundPoints
				.map((x) => `<li><span>${esc(x.name)}${x.isPhotographer ? ' <i class="tagchip">photographer</i>' : ""}</span><b>+${x.pts}</b></li>`)
				.join("")}</ul>`,
		],
		["guesses", r.guesses.length ? `<details><summary>All guesses (${r.guesses.length})</summary><ul class="judge">${r.guesses.map((g) => judgeRow(g, r.isPhotographer)).join("")}</ul></details>` : ""],
		[
			"next",
			`<div class="nextrow">${canNext ? `<button class="primary" data-act="next">${isLast ? "Final results" : "Next round"}</button>` : ""}
			<span class="muted">${isLast ? "Results" : "Next round"} in <span class="mono" data-until="${s.phaseEndsAt}"></span></span></div>`,
		],
		["scores", scores(s)],
	];
}

function overScreen(s) {
	const [w] = s.standings;
	const avg = (x) => (x.avgBytes === null ? "–" : `${Math.round(x.avgBytes)} B`);
	const level = s.standings.filter((x) => x.score === w.score);
	const dead = level.filter((x) => x.avgBytes === w.avgBytes); // same points and same bytes: a true tie
	const headline = dead.length > 1 ? `${dead.map((x) => esc(x.name)).join(" & ")} tie` : `${esc(w.name)} wins`;
	const sub =
		dead.length > 1
			? `${w.score} points each, with the same average bytes`
			: `${w.score} points${level.length > 1 ? `, tie broken by fewer bytes (${avg(w)} average)` : ""}`;
	const threshold =
		s.threshold === null
			? `<p class="muted">Nobody recognised a photo this game. Try objects with a strong shape or colour.</p>`
			: `<div class="threshold"><p class="kicker">This room's semantic threshold</p><div class="bigcode mono tight">${s.threshold} B</div>
			<p class="muted">On average your photos were first recognised from just ${s.threshold} bytes. The lowest-quality JPEG of a photo needs about 1,800.</p></div>`;
	return [
		[
			"winner",
			`<div class="center-block"><p class="kicker">Game over</p><h1 class="winner">${headline}</h1><p>${sub}</p></div>`,
		],
		[
			"standings",
			`<table class="standings"><thead><tr><th></th><th>Player</th><th>Points</th><th>Avg bytes to guess</th></tr></thead><tbody>${s.standings
				.map((x, i) => `<tr class="${x.id === s.you.id ? "you" : ""}"><td>${i + 1}</td><td>${esc(x.name)}</td><td><b>${x.score}</b></td><td class="mono">${avg(x)}</td></tr>`)
				.join("")}</tbody></table>`,
		],
		["threshold", threshold],
		[
			"history",
			s.history.length
				? `<h3>Photos</h3><ul class="history">${s.history
						.map((h) => `<li><img onerror="retryImg(this)" src="${imgUrl(h.id, "photo")}" alt=""><span><b>${esc(h.answer)}</b> ${h.mode === "imagine" ? "imagined for" : "by"} ${esc(h.photographer)}<br><span class="muted">${h.firstBytes ? `recognised at ${h.firstBytes} B` : "not recognised"}</span></span></li>`)
						.join("")}</ul>`
				: "",
		],
		[
			"again",
			`${s.you.isHost ? `<button class="primary big" data-act="again">Play again</button>` : `<p class="waiting">Waiting for the host to start another game…</p>`}
			<button class="ghost" data-act="leave">Leave room</button>`,
		],
	];
}

// ---- Clock-driven updates -------------------------------------------------------------------

function tick() {
	const now = serverNow();
	for (const el of app.querySelectorAll("[data-until]")) {
		el.textContent = `${Math.max(0, Math.ceil((Number(el.dataset.until) - now) / 1000))}s`;
	}
	if (state?.phase === "reveal" && state.round && mounted.screen?.startsWith("reveal")) updateReveal(now);
}

function updateReveal(now) {
	const r = state.round;
	const rung = r.revealAt && now >= r.revealAt ? Math.min(RUNGS.length - 1, Math.floor((now - r.revealAt) / r.rungMs)) : -1;
	const $ = (id) => document.getElementById(id);
	$("count").textContent = rung < 0 ? Math.max(1, Math.ceil((r.revealAt - now) / 1000)) : "";
	$("count").hidden = rung >= 0;
	if (rung >= 0) setPic($("pic"), imgUrl(r.id, rung));
	for (const seg of $("meter").children) seg.classList.toggle("on", Number(seg.dataset.i) <= rung);
	$("bytes").textContent = rung < 0 ? "Get ready…" : `${RUNGS[rung]} bytes`;
	$("detail").textContent = rung < 0 ? "" : r.decoder !== "standin" ? `${RUNGS[rung] / 2} token${rung ? "s" : ""}` : describe(RUNGS[rung]);
	const next = r.revealAt + (rung + 1) * r.rungMs;
	$("nextIn").textContent = rung < 0 ? "" : rung < RUNGS.length - 1 ? `more in ${Math.ceil((next - now) / 1000)}s` : "last level";

	if (r.isPhotographer) return;
	const solved = r.myGuesses.some((g) => g.correct);
	const status = $("guessStatus");
	if (r.choices) {
		const picked = r.myGuesses[0] ?? null;
		for (const b of app.querySelectorAll(".choice")) {
			const i = Number(b.dataset.i);
			b.disabled = rung < 0 || !!picked || busy;
			b.classList.toggle("on", picked?.choice === i && picked.correct);
			b.classList.toggle("wrong", picked?.choice === i && !picked.correct);
		}
		status.textContent = picked
			? picked.correct
				? `You got it at ${bytesLabel(picked.rung)}: +${POINTS[picked.rung]}.`
				: `Not that one. Your pick is used up for this round.`
			: rung < 0
				? "One pick only. The picture starts in a moment."
				: `One pick only. Tap now for ${POINTS[rung]} points, or wait for more bytes.`;
		return;
	}
	const spent = r.myGuesses.some((g) => g.rung === rung);
	const last = r.myGuesses[r.myGuesses.length - 1];
	const btn = $("guessBtn"), input = $("guess");
	btn.disabled = input.disabled = rung < 0 || solved || spent || busy;
	btn.textContent = rung < 0 ? "Guess" : `Guess · ${POINTS[rung]}`;
	status.textContent = solved
		? "You got it! Sit back and watch the others."
		: spent
			? last?.verdict === "warm"
				? "Close! Not quite. Refine it when more bytes arrive."
				: "Locked in. Wait for more bytes to guess again."
			: rung < 0
				? "The picture starts in a moment."
				: `Worth ${POINTS[rung]} points right now.`;
}

function setPic(el, url) {
	if (el.dataset.want === url) return;
	el.dataset.want = url;
	const im = new Image();
	im.onload = () => {
		if (el.dataset.want === url) el.src = url;
	};
	// Our clock can run a little ahead of the server's; ask again shortly
	im.onerror = () => setTimeout(() => el.dataset.want === url && (el.dataset.want = ""), 400);
	im.src = url;
}

setInterval(tick, 200);

// FlexTok may still be developing the later rungs when a round ends early; try again shortly
window.retryImg = (el) => {
	const tries = Number(el.dataset.tries ?? 0);
	if (tries >= 30) return;
	el.dataset.tries = tries + 1;
	setTimeout(() => {
		const u = new URL(el.src);
		u.searchParams.set("try", tries + 1);
		el.src = u;
	}, 1000);
};

// ---- Camera and photo -----------------------------------------------------------------------

function onMount(screen) {
	if (screen.startsWith("shoot-me")) {
		if (shot?.roundId !== state.round.id) shot = null;
		bet = null;
		chosen = null;
		if (!info.imagine) mode = "camera";
		if (info.imagine && !classes) loadClasses();
		startCamera();
	}
}

async function startCamera() {
	if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return;
	try {
		const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
		if (!mounted.screen?.startsWith("shoot-me")) return stream.getTracks().forEach((t) => t.stop());
		camStream = stream;
		const v = document.getElementById("video");
		v.srcObject = stream;
		await v.play().catch(() => {});
		updateShootControls();
	} catch {
		camStream = null; // permission denied or no camera: the photo picker still works
	}
}

function stopCamera() {
	if (!camStream) return;
	camStream.getTracks().forEach((t) => t.stop());
	camStream = null;
}

function updateShootControls() {
	const $ = (id) => document.getElementById(id);
	const imagine = mode === "imagine";
	for (const t of app.querySelectorAll(".tab")) t.classList.toggle("on", t.dataset.mode === mode);
	app.querySelector('[data-sec="cam"]').hidden = imagine;
	app.querySelector('[data-sec="imagine"]').hidden = !imagine;
	$("answerField").hidden = imagine;
	$("modeHint").textContent = imagine
		? "FlexAR on the host laptop writes the picture's tokens itself. Pick a thing; the others guess what it imagined."
		: "Photograph something nearby that the others could name. It gets cropped to a square.";
	$("decoys").hidden = !$("mcToggle").checked;
	const live = !!camStream && !shot;
	$("video").hidden = !live;
	$("preview").hidden = !shot;
	if (shot) $("preview").src = shot.photo;
	$("camEmpty").hidden = live || !!shot;
	$("shutterBtn").hidden = !live;
	$("retakeBtn").hidden = !shot;
	$("pickLabel").hidden = !!shot;
	$("pickText").textContent = camStream ? "Choose a photo instead" : "Take or choose a photo";
	for (const c of app.querySelectorAll('[data-act="bet"]')) c.classList.toggle("on", (c.dataset.i === "" ? null : Number(c.dataset.i)) === bet);
	const ready = imagine ? !!chosen : !!shot;
	$("sendBtn").disabled = busy || !ready;
	$("sendBtn").textContent = busy ? "Sending…" : ready ? "Send it" : imagine ? "Pick something first" : "Take a photo first";
}

// ---- Imagine: picking an ImageNet class ------------------------------------------------------

async function loadClasses() {
	try {
		classes = await (await fetch("imagenet-classes.json", { cache: "force-cache" })).json();
	} catch {
		toast("Couldn't load the list of things to imagine.");
	}
}

function searchClasses(q) {
	const list = document.getElementById("classList");
	if (!list) return;
	q = q.trim().toLowerCase();
	if (!classes || q.length < 2) return (list.innerHTML = "");
	const hits = [];
	for (let i = 0; i < classes.length && hits.length < 8; i++) {
		const [name, alts] = classes[i];
		if ([name, ...alts].some((w) => w.toLowerCase().includes(q))) hits.push([i, name, alts]);
	}
	list.innerHTML = hits.length
		? hits.map(([i, name, alts]) => `<button type="button" class="classhit" data-act="class" data-i="${i}"><b>${esc(name)}</b>${alts.length ? `<span class="muted"> · ${esc(alts.join(", "))}</span>` : ""}</button>`).join("")
		: `<p class="muted">Nothing like that in ImageNet's 1000 things. Try a breed, a food, a vehicle, an object…</p>`;
}

function showClassPick() {
	const el = document.getElementById("classPick");
	if (!el) return;
	el.hidden = !chosen;
	if (chosen)
		el.innerHTML = `Imagining: <b>${esc(chosen.name)}</b>${chosen.synonyms.length ? ` <span class="muted">(also accepts ${esc(chosen.synonyms.join(", "))})</span>` : ""}
			<button type="button" class="tiny" data-act="unclass">Change</button><br><span class="muted">FlexAR has started writing it. Add answers, decoys or a bet, then send.</span>`;
	updateShootControls();
}

function squareCanvas(source, w, h) {
	const c = document.createElement("canvas");
	c.width = c.height = 256;
	const side = Math.min(w, h);
	const ctx = c.getContext("2d");
	ctx.imageSmoothingQuality = "high";
	ctx.drawImage(source, (w - side) / 2, (h - side) / 2, side, side, 0, 0, 256, 256);
	return c;
}

function useCanvas(c) {
	shot = { roundId: state.round.id, photo: c.toDataURL("image/jpeg", 0.9), ladder: standinLadder(c) };
	updateShootControls();
}

async function useFile(file) {
	try {
		const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
		useCanvas(squareCanvas(bmp, bmp.width, bmp.height));
	} catch {
		const url = URL.createObjectURL(file);
		const img = new Image();
		img.onload = () => {
			useCanvas(squareCanvas(img, img.naturalWidth, img.naturalHeight));
			URL.revokeObjectURL(url);
		};
		img.onerror = () => toast("That file isn't a photo this browser can read.");
		img.src = url;
	}
}

// ---- Events ---------------------------------------------------------------------------------

const actions = {
	async copy() {
		const link = document.getElementById("link");
		try {
			await navigator.clipboard.writeText(link.value);
			toast("Link copied");
		} catch {
			link.select();
		}
	},
	start: () => run(() => api("start")),
	next: () => run(() => api("next")),
	again: () => run(() => api("again")),
	leave: () =>
		run(async () => {
			await api("leave").catch(() => {});
			setSession(null);
		}),
	judge: (el) => run(() => api("judge", { guessId: el.dataset.id, correct: el.dataset.correct === "1" })),
	bet(el) {
		bet = el.dataset.i === "" ? null : Number(el.dataset.i);
		updateShootControls();
	},
	mode(el) {
		mode = el.dataset.mode;
		updateShootControls();
		if (mode === "imagine") document.getElementById("classq")?.focus();
	},
	async class(el) {
		const label = Number(el.dataset.i);
		const [name, synonyms] = classes[label];
		const previous = chosen?.job ?? null;
		chosen = { label, name, synonyms, job: null };
		document.getElementById("classList").innerHTML = "";
		showClassPick();
		try {
			const { job } = await api("prepare", { label, replaces: previous });
			if (chosen?.label === label) chosen.job = job;
		} catch (e) {
			toast(e.message);
		}
	},
	unclass() {
		chosen = null;
		showClassPick();
		document.getElementById("classq")?.focus();
	},
	pick: (el) => run(() => api("pick", { choice: Number(el.dataset.i) })),
	shutter() {
		const v = document.getElementById("video");
		if (!v.videoWidth) return;
		useCanvas(squareCanvas(v, v.videoWidth, v.videoHeight));
	},
	retake() {
		shot = null;
		updateShootControls();
	},
};

const forms = {
	create() {
		const name = document.getElementById("name").value.trim();
		saveJSON("hfb-name", name);
		return run(async () => {
			setSession(null);
			setSession(await api("create", { name }));
		});
	},
	join() {
		const name = document.getElementById("name").value.trim();
		const code = document.getElementById("code").value.trim().toUpperCase();
		saveJSON("hfb-name", name);
		if (code.length !== 4) return toast("Room codes are 4 letters.");
		return run(async () => {
			setSession(null);
			setSession(await api("join", { name, code }));
			history.replaceState(null, "", location.pathname);
		});
	},
	photo() {
		const $ = (id) => document.getElementById(id);
		const imagine = mode === "imagine";
		if (imagine && !chosen) return toast("Pick something for FlexAR to imagine.");
		if (!imagine && !shot) return toast("Take a photo first.");
		const answer = $("answer").value.trim();
		if (!imagine && !answer) return toast("Type what your photo shows.");
		const decoys = $("mcToggle").checked ? [1, 2, 3].map((i) => $(`decoy${i}`).value.trim()) : [];
		if (decoys.length && decoys.some((d) => !d)) return toast("Multiple choice needs all 3 decoys.");
		const common = { alternates: $("alternates").value, decoys, call: bet };
		const sent = shot;
		const pick = chosen;
		return run(async () => {
			const res = imagine
				? await api("photo", { ...common, mode: "imagine", label: pick.label, job: pick.job })
				: await api("photo", { ...common, photo: sent.photo, ladder: sent.ladder, answer });
			if (!imagine && res.decoder === "standin" && info.decoder === "flextok")
				toast("FlexTok was busy, so the stand-in decoder developed this one.");
		});
	},
	guess() {
		const input = document.getElementById("guess");
		const text = input.value.trim();
		if (!text) return;
		return run(async () => {
			await api("guess", { text });
			input.value = "";
		});
	},
};

app.addEventListener("click", (e) => {
	const el = e.target.closest("[data-act]");
	if (el && actions[el.dataset.act]) {
		e.preventDefault();
		actions[el.dataset.act](el);
	}
});

app.addEventListener("submit", (e) => {
	const f = e.target.closest("[data-form]");
	if (!f) return;
	e.preventDefault();
	forms[f.dataset.form]?.();
});

app.addEventListener("change", (e) => {
	if (e.target.id === "file" && e.target.files[0]) useFile(e.target.files[0]);
	if (e.target.id === "mcToggle") updateShootControls();
});

app.addEventListener("input", (e) => {
	if (e.target.id === "classq") searchClasses(e.target.value);
});

document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && poll());

let toastTimer;
function toast(msg) {
	const t = document.getElementById("toast");
	t.textContent = msg;
	t.classList.add("show");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

api("info")
	.then((i) => (info = i))
	.catch(() => {})
	.finally(() => {
		mounted.screen = null; // redraw the home badge with the decoder we found
		poll();
	});
