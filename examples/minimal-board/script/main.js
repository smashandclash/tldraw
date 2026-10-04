// The smallest useful Smash&Clash client on a tldraw board: about 140 lines.
//
// It plays the house opponent with plain tldraw shapes (no card art): click "New game", click a
// card in your hand, then a tile. Effects and hops show up as buttons under the board, named the
// way the SDK names them ("FLIP", "BOULDER(D2)", "hop→E3"), so every legal move is one click away.
//
// Read this one first; ../../board/script/main.js is the full client built the same way.
// Docs: https://docs.smashandclash.in

import { createShapeId, toRichText } from 'tldraw'
import { SmashAndClash } from './smashandclash-sdk.js'

// SDK 0.2.0 in a browser: drop its x-sdk header (older API deployments refuse it cross-origin) and
// call fetch from a plain function (calling it as a method throws "Illegal invocation").
const browserFetch = (url, init = {}) => {
	const headers = { ...init.headers }
	delete headers['x-sdk']
	return fetch(url, { ...init, headers })
}

const TILE = 144
const COLS = 'ABCDE'

/** @param {import('../.script-workspace/script-context').MainScriptContext} ctx */
export default function ({ editor, helpers, signal }) {
	const sc = new SmashAndClash({ fetch: browserFetch })
	let game = null // the SDK's Game: game.view is what your seat sees
	let selected = null // the name of the hand card you picked
	let busy = false
	let message = 'Click New game.'
	let drawn = [] // ids of the shapes we drew last time
	let buttons = [] // [{ id, onClick }]

	// --- actions: every one goes through the SDK, then we redraw from game.view ---
	async function run(text, fn) {
		if (busy) return
		busy = true
		message = text
		draw()
		try {
			await fn()
			message = game.over ? `Game over: ${game.winner === 'you' ? 'you win!' : 'they win.'} Replay: ${game.replayUrl}` : 'Your turn.'
		} catch (e) {
			message = e.message // SmashAndClashError: an illegal move is a 422 listing the legal moves
		}
		busy = false
		draw()
	}
	const newGame = () =>
		run('Dealing…', async () => {
			if (game && !game.over) await game.resign().catch(() => {}) // don't leave the old game hanging
			game = await sc.games.startHouse({ name: 'tldraw', as: 'person' })
		})
	const play = (move) => run(`Playing ${move}…`, async () => { selected = null; await game.play(move) }) // the house answers before play() resolves

	function clickTile(cell) {
		if (!game?.yourTurn || !selected) return
		const move = game.legalMoves.find((m) => m === `${selected}@${cell}` || m === `${selected}!${cell}`)
		if (move) play(move)
		else { message = `${selected} can't go on ${cell}.`; draw() }
	}

	// --- drawing: plain geo shapes, rendered ephemerally (they never land in the saved file) ---
	const sidesText = (n, e, s, w) => `${n}\n${w}      ${e}\n${s}`
	function draw() {
		const v = game?.view
		const shapes = []
		buttons = []
		const box = (key, x, y, w, h, label, props = {}, onClick) => {
			const id = createShapeId(`min-${key}`)
			shapes.push({ id, type: 'geo', x, y, isLocked: true, props: { w, h, geo: 'rectangle', richText: toRichText(label), size: 's', font: 'sans', ...props } })
			if (onClick) buttons.push({ id, onClick })
		}
		box('new', 0, -80, 200, 56, 'New game', { fill: 'solid', color: 'blue' }, newGame)
		box('msg', 220, -80, 600, 56, message, { color: 'grey', align: 'start' })

		// the board, from your side: row 1 is nearest seat A, so seat B sees it turned round
		// (rows and columns reversed, and each card's board-frame sides turned with it)
		const flip = game?.state.seat === 'B'
		const tiles = new Map((v?.board ?? []).map((t) => [t.cell, t]))
		for (let r = 1; r <= 3; r++) {
			for (let c = 0; c < 5; c++) {
				const cell = `${COLS[c]}${r}`
				const t = tiles.get(cell)
				const s = t?.sides
				const label = !t?.card ? cell : flip ? `${t.card}\n${sidesText(s.south, s.west, s.north, s.east)}` : `${t.card}\n${sidesText(s.north, s.east, s.south, s.west)}`
				const color = t?.card ? (t.owner === 'you' ? 'blue' : 'orange') : 'grey'
				const x = (flip ? 4 - c : c) * (TILE + 8)
				const y = (flip ? r - 1 : 3 - r) * (TILE + 8)
				box(`tile-${cell}`, x, y, TILE, TILE, label, { color, fill: t?.card ? 'semi' : 'none' }, () => clickTile(cell))
			}
		}

		// your hand: characters show their four sides as printed (top, right, bottom, left)
		;(v?.hand ?? []).forEach((h, i) => {
			const label = h.kind === 'character' ? `${h.card}\n${sidesText(h.top, h.right, h.bottom, h.left)}` : `${h.card}\n(effect)`
			box(`hand-${i}`, i * (TILE + 8), 3 * (TILE + 8) + 30, TILE, TILE + 20, label, { color: selected === h.card ? 'green' : 'blue', fill: 'solid' }, () => {
				selected = selected === h.card ? null : h.card
				draw()
			})
		})

		// every legal move that isn't "card on a tile" (effects, hops, overruns), as a button
		const others = game?.yourTurn ? game.legalMoves.filter((m) => !/@[A-E][1-3]$/.test(m)) : []
		others.forEach((m, i) => box(`move-${i}`, 5 * (TILE + 8) + 20, i * 46, 220, 40, m, { color: 'violet', fill: 'solid' }, () => play(m)))

		helpers.renderEphemeral(() =>
			editor.run(() => {
				editor.deleteShapes(drawn.filter((id) => editor.getShape(id)))
				editor.createShapes(shapes)
			}, { ignoreShapeLock: true })
		)
		drawn = shapes.map((s) => s.id)
	}

	// --- clicks: hit-test our locked shapes ourselves (a click on a locked shape selects nothing) ---
	function onEvent(info) {
		if (info.type !== 'pointer' || info.name !== 'pointer_down' || editor.getCurrentToolId() !== 'select') return
		const point = editor.screenToPage(info.point)
		const hit = buttons.find((b) => editor.isPointInShape(b.id, point, { hitInside: true }))
		if (hit) setTimeout(hit.onClick, 0) // leave the editor's event dispatch before drawing
	}
	// ephemeral shapes outlive a script rerun: clear ours on the way out and on the way in
	const clear = () => {
		const ids = [...editor.getCurrentPageShapeIds()].filter((id) => id.startsWith('shape:min-'))
		helpers.renderEphemeral(() => editor.run(() => editor.deleteShapes(ids), { ignoreShapeLock: true }))
	}
	editor.on('event', onEvent)
	signal.addEventListener('abort', () => {
		editor.off('event', onEvent)
		clear()
	})
	clear()
	draw()
}
