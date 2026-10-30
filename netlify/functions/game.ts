// The always-on fallback: the whole game API as one Netlify Function backed by Netlify Blobs.
// There is no FlexTok here, so ladders come from the browser's stand-in decoder.
import { getStore } from "@netlify/blobs";
import { handle } from "../../shared/handler.js";
import { blobsStore } from "../../shared/blobs-store.js";

export default async (req: Request) => {
	const url = new URL(req.url);
	const body = req.method === "POST" ? await req.json().catch(() => null) : null;
	const store = blobsStore(getStore({ name: "how-few-bytes", consistency: "strong" }));
	const res = await handle(
		{ method: req.method, params: Object.fromEntries(url.searchParams), body },
		{ store, now: Date.now(), decoder: null, decoderName: "standin" },
	);
	if (res.bytes) {
		return new Response(res.bytes, {
			status: res.status,
			headers: { "content-type": res.contentType, "cache-control": "private, max-age=3600" },
		});
	}
	return new Response(JSON.stringify(res.json), {
		status: res.status,
		headers: { "content-type": "application/json", "cache-control": "no-store" },
	});
};
