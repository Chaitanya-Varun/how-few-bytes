// Stand-in decoder for when FlexTok isn't available: the classical baseline from the proposal,
// down-sampling at the same byte budget. Each rung keeps exactly as many bytes as FlexTok would
// (2 per token): a tiny n x n image in YCbCr, luma only below 32 bytes, 4:2:0 chroma above, one
// byte per sample. It is then scaled back to 256 x 256 with bilinear smoothing.
export const RUNGS = [2, 4, 8, 16, 32, 64, 128, 256, 512];
const SIZE = 256;

export function budgetShape(bytes) {
	if (bytes < 32) return { n: Math.max(1, Math.floor(Math.sqrt(bytes))), chroma: false };
	const cost = (n) => n * n + 2 * Math.ceil(n / 2) ** 2;
	let n = 1;
	while (cost(n + 1) <= bytes) n++;
	return { n, chroma: true, used: cost(n) };
}

export function describe(bytes) {
	const { n, chroma, used } = budgetShape(bytes);
	return chroma ? `${n}×${n} px, YCbCr 4:2:0 (${used} B)` : `${n}×${n} px, grey (${n * n} B)`;
}

// Mean colour of each cell of an n x n grid laid over the 256 x 256 image
function blockMeans(data, n) {
	const out = new Float32Array(n * n * 3);
	for (let by = 0; by < n; by++) {
		const y0 = Math.floor((by * SIZE) / n), y1 = Math.floor(((by + 1) * SIZE) / n);
		for (let bx = 0; bx < n; bx++) {
			const x0 = Math.floor((bx * SIZE) / n), x1 = Math.floor(((bx + 1) * SIZE) / n);
			let r = 0, g = 0, b = 0;
			for (let y = y0; y < y1; y++) {
				for (let x = x0; x < x1; x++) {
					const i = (y * SIZE + x) * 4;
					r += data[i]; g += data[i + 1]; b += data[i + 2];
				}
			}
			const k = (x1 - x0) * (y1 - y0), o = (by * n + bx) * 3;
			out[o] = r / k; out[o + 1] = g / k; out[o + 2] = b / k;
		}
	}
	return out;
}

const clamp8 = (v) => Math.max(0, Math.min(255, Math.round(v)));

// The bytes a sender would transmit for this rung, decoded back to an n x n RGBA image
function encodeDecode(data, bytes) {
	const { n, chroma } = budgetShape(bytes);
	const rgb = blockMeans(data, n);
	const Y = new Uint8Array(n * n), Cb = new Float32Array(n * n), Cr = new Float32Array(n * n);
	for (let i = 0; i < n * n; i++) {
		const [r, g, b] = [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]];
		Y[i] = clamp8(0.299 * r + 0.587 * g + 0.114 * b);
		Cb[i] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
		Cr[i] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
	}
	// One byte of Cb and Cr per 2 x 2 block of luma, shared back out when decoding
	const m = Math.ceil(n / 2);
	const cb = new Uint8Array(m * m).fill(128), cr = new Uint8Array(m * m).fill(128);
	if (chroma) {
		for (let by = 0; by < m; by++) {
			for (let bx = 0; bx < m; bx++) {
				let sb = 0, sr = 0, k = 0;
				for (let y = by * 2; y < Math.min(n, by * 2 + 2); y++) {
					for (let x = bx * 2; x < Math.min(n, bx * 2 + 2); x++) {
						sb += Cb[y * n + x]; sr += Cr[y * n + x]; k++;
					}
				}
				cb[by * m + bx] = clamp8(sb / k);
				cr[by * m + bx] = clamp8(sr / k);
			}
		}
	}
	const img = new ImageData(n, n);
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			const i = y * n + x, c = (y >> 1) * m + (x >> 1);
			const yy = Y[i], u = cb[c] - 128, v = cr[c] - 128;
			img.data[i * 4] = clamp8(yy + 1.402 * v);
			img.data[i * 4 + 1] = clamp8(yy - 0.344136 * u - 0.714136 * v);
			img.data[i * 4 + 2] = clamp8(yy + 1.772 * u);
			img.data[i * 4 + 3] = 255;
		}
	}
	return img;
}

// Nine 256 x 256 JPEG data URLs, one per rung, from a 256 x 256 canvas holding the photo
export function standinLadder(photoCanvas) {
	const data = photoCanvas.getContext("2d").getImageData(0, 0, SIZE, SIZE).data;
	const tiny = document.createElement("canvas");
	const out = document.createElement("canvas");
	out.width = out.height = SIZE;
	const octx = out.getContext("2d");
	return RUNGS.map((bytes) => {
		const img = encodeDecode(data, bytes);
		tiny.width = tiny.height = img.width;
		tiny.getContext("2d").putImageData(img, 0, 0);
		octx.imageSmoothingEnabled = true;
		octx.imageSmoothingQuality = "high";
		octx.clearRect(0, 0, SIZE, SIZE);
		octx.drawImage(tiny, 0, 0, SIZE, SIZE);
		return out.toDataURL("image/jpeg", 0.85);
	});
}
