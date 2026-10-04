// Smash&Clash, playable on this board, through the official SDK (@smashandclash/sdk, bundled
// next to this file as smashandclash-sdk.js). Docs: https://docs.smashandclash.in
//
// How it plays: click a card in your hand, then a green tile. Effects that need a target
// light their tiles the same way; an effect with no target (Flip!, Swap!) plays when you click
// it a second time. The panel on the right starts games: New game (an opponent at your level),
// Quick match (whoever is online) and Invite a friend (they play you in their browser).
//
// Everything the game draws is ephemeral: it renders here but never lands in the document, so a
// saved board stays clean and redraws itself on open. The document keeps only the game's record
// (meta.smashandclash): your rating, your ruleset and the game in progress, so reopening the
// board picks that game up again. All game shapes are locked: Edit → Unlock All frees them.

import { AssetRecordType, createShapeId, toRichText } from 'tldraw'
import { SmashAndClash } from './smashandclash-sdk.js'

const SITE = 'https://www.smashandclash.in'
const CARD_BACK = `${SITE}/Card_Back_v2.png`
const LOGO = `${SITE}/Smash%26Clash_Logo.svg`

// The SDK 0.2.0 tags each request with an x-sdk header that older API deployments do not allow
// cross-origin, and calls fetch unbound ("Illegal invocation" in a browser). This sends the same
// request without that header, from a plain function. Harmless once both fixes have shipped.
function fetchWithoutSdkHeader(url, init = {}) {
	const headers = { ...init.headers }
	delete headers['x-sdk']
	return fetch(url, { ...init, headers })
}

/* ---------------------------------- layout ---------------------------------- */

const CW = 132 // a board tile (card art is 563×768)
const CH = 180
const GAP = 10
const BX = 0
const BY = 200
const BOARD_W = 5 * CW + 4 * GAP
const BOARD_H = 3 * CH + 2 * GAP
const HAND_Y = BY + BOARD_H + 52
const PX = BOARD_W + 56 // the side panel
const PW = 360
const BACK_W = 62
const BACK_H = 85
const COLS = 'ABCDE'

// Viewer-relative colour: you are blue, the other side orange, whichever seat you hold.
const YOU = 'blue'
const THEM = 'orange'
const POWER_COLOR = { pink: 'light-red', blue: 'blue', red: 'red', green: 'green', orange: 'orange', purple: 'violet', gray: 'grey' }
const PIECE = { knight: '♞', bishop: '♝', rook: '♜', queen: '♛' }

/* ---------------------------------- moves ----------------------------------- */

// Move names: "Pengu@C2" places, "Teddy!C2" overruns, "hop→E3" / "hop: stay" resolve a hop,
// "BOULDER(D2)", "FREEZE(C1)", "RECRUIT(D3→B1)", "FLIP" and "SWAP" play an effect.
function parseMove(name) {
	let m
	if ((m = /^(.+)[@!]([A-E][1-3])$/.exec(name))) return { name, key: m[1], cells: [m[2]] }
	if ((m = /^hop→([A-E][1-3])$/.exec(name))) return { name, key: 'hop', cells: [m[1]] }
	if (name.startsWith('hop')) return { name, key: 'hop', cells: [] }
	if ((m = /^([A-Z]+)\((.*)\)$/.exec(name))) return { name, key: m[1], cells: m[2].split('→') }
	return { name, key: name, cells: [] }
}

// The key a hand card's moves start with: its name, or an effect's keyword ("Boulder!" → BOULDER).
const handKey = (card) => (card.kind === 'effect' ? card.card.replace(/!$/, '').toUpperCase() : card.card)

const short = (name, n) => (name.length > n ? `${name.slice(0, n - 1)}…` : name)

/* --------------------------------- personas --------------------------------- */

// The opponent at your level wears a player's handle, never a label for what it is: the same
// shapes the lobby has (the minted Adjective+Noun+digits a guest gets, or a first name).
const ADJECTIVES = ['Brave', 'Swift', 'Sneaky', 'Mighty', 'Wobbly', 'Spicy', 'Turbo', 'Cosmic', 'Jolly', 'Rapid', 'Zesty', 'Lucky', 'Cheeky', 'Bouncy', 'Fuzzy', 'Nifty', 'Bold', 'Snappy', 'Plucky', 'Stormy', 'Frosty', 'Toasty']
const NOUNS = ['Otter', 'Tiger', 'Pengu', 'Yeti', 'Falcon', 'Walrus', 'Comet', 'Ninja', 'Badger', 'Phoenix', 'Koala', 'Bison', 'Hawk', 'Panda', 'Wombat', 'Moose', 'Lynx', 'Heron', 'Gecko', 'Puffin', 'Quokka', 'Ibex']
const FIRST_NAMES = ['arjun', 'priya', 'rohan', 'aisha', 'kabir', 'meera', 'ishan', 'tara', 'zoya', 'sana', 'kenji', 'yuki', 'mei', 'jisoo', 'hana', 'sora', 'leo', 'maya', 'nina', 'omar', 'theo', 'aria', 'finn', 'luca', 'noor', 'ivy']

function rngFrom(text) {
	let a = 2166136261
	for (const ch of text) a = Math.imul(a ^ ch.charCodeAt(0), 16777619)
	return () => {
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function personaName(gameId) {
	const rng = rngFrom(gameId)
	const pick = (xs) => xs[Math.min(xs.length - 1, Math.floor(rng() * xs.length))]
	const roll = rng()
	if (roll < 0.45) return `${pick(ADJECTIVES)}${pick(NOUNS)}${Math.floor(rng() * 1000)}`
	const first = pick(FIRST_NAMES)
	if (roll < 0.7) return first
	if (roll < 0.85) return `${first}${String(Math.floor(rng() * 90) + 10)}`
	return `${first}_${String.fromCharCode(97 + Math.floor(rng() * 26))}`
}

/* ---------------------------------- script ---------------------------------- */

/** @param {import('../.script-workspace/script-context').MainScriptContext} ctx */
export default function ({ editor, helpers, signal, app }) {
	// On a shared board every participant runs this script and plays their own game (it is all
	// ephemeral); only the board's host writes the record into the document.
	const isHost = app?.board?.isHost ?? true
	const sc = new SmashAndClash({ fetch: fetchWithoutSdkHeader })
	const playerName = (editor.user.getName() || '').trim() || 'tldraw player'

	let disposed = false
	let cards = new Map() // card name → { image, … } from sc.cards()
	let record = { rating: 1200, played: 0, won: 0, ruleset: 'mutators', active: null, ...(editor.getDocumentSettings().meta?.smashandclash ?? {}) }

	let game = null // the SDK Game
	let mode = null // 'house' | 'quick' | 'invite'
	let strength = 1200 // the opponent's rating in a house game
	let inviteUrl = null
	let busy = null // what we are waiting on, for the status line
	let selected = null // index into your hand
	let path = [] // tiles picked so far for the selected card's move
	let pending = null // { cell, card } drawn while a placement is on its way
	let flash = new Set() // tiles that changed with the last move
	let review = null
	let resigned = false
	let finishedId = null
	let opponentHand = 5
	let notice = null // { text, until }
	let armed = null // { key, until }: a second click confirms
	let showRules = false
	let rulesText = ''
	let pumpGen = 0

	const live = new Map() // shape id → the JSON of what was last written
	let clickables = [] // [{ id, onClick }], top-most first

	function saveRecord(patch) {
		record = { ...record, ...patch }
		if (!isHost || disposed) return
		const meta = editor.getDocumentSettings().meta
		editor.run(() => editor.updateDocumentSettings({ meta: { ...meta, smashandclash: record } }), { history: 'ignore' })
	}

	/* ------------------------------ state helpers ------------------------------ */

	const view = () => game?.view
	const mySeat = () => game?.state.seat ?? 'A'
	const active = () => !!game && !game.over
	const say = (text, ms = 3500) => {
		notice = { text, until: Date.now() + ms }
		setTimeout(render, ms + 50)
	}

	function opponentName() {
		if (!game) return ''
		const s = game.state
		const other = mySeat() === 'A' ? 'B' : 'A'
		if (s.playerKinds?.[other] === 'house') return personaName(s.id)
		return s.players?.[other] ?? 'Opponent'
	}

	function owners() {
		const out = new Map()
		for (const t of view()?.board ?? []) if (t.card) out.set(t.cell, `${t.card}:${t.owner}:${t.frozen ? 1 : 0}`)
		return out
	}

	function candidates() {
		const v = view()
		if (!v || !game.yourTurn || busy) return []
		const moves = v.legalMoves.map(parseMove)
		if (v.pendingHop) return moves.filter((m) => m.key === 'hop')
		const card = selected == null ? null : v.hand[selected]
		return card ? moves.filter((m) => m.key === handKey(card)) : []
	}

	function targets() {
		const next = candidates().filter((m) => m.cells.length > path.length && path.every((c, i) => m.cells[i] === c))
		return new Set(next.map((m) => m.cells[path.length]))
	}

	const playable = (card) => !!view()?.legalMoves.some((n) => parseMove(n).key === handKey(card))

	function errorText(e) {
		const msg = e?.message || String(e)
		if (/failed to fetch/i.test(msg)) return 'Could not reach smashandclash.in. Check your connection and try again.'
		return e?.hint ? `${msg} ${e.hint}` : msg
	}

	/* --------------------------------- actions --------------------------------- */

	async function task(label, fn) {
		if (busy) return
		busy = label
		render()
		try {
			await fn()
		} catch (e) {
			say(errorText(e), 6000)
		} finally {
			busy = null
			render()
		}
	}

	function confirmClick(key, text) {
		if (armed?.key === key && armed.until > Date.now()) {
			armed = null
			return true
		}
		armed = { key, until: Date.now() + 4000 }
		say(text, 4000)
		render()
		return false
	}

	async function ensureCards() {
		if (cards.size) return
		const list = await sc.cards()
		cards = new Map(list.map((c) => [c.name, c]))
	}

	function adopt(g, m, extra = {}) {
		pumpGen++
		game = g
		mode = m
		strength = extra.strength ?? strength
		inviteUrl = extra.inviteUrl ?? null
		selected = null
		path = []
		pending = null
		flash = new Set()
		review = null
		resigned = false
		finishedId = null
		opponentHand = 5
		saveRecord({ active: { id: g.id, token: g.playerToken, mode: m, strength, inviteUrl } })
		afterChange(new Map())
	}

	function startGame(m) {
		const key = `start-${m}`
		if (active() && !game.waiting && !confirmClick(key, 'Click again to resign this game and start another.')) return
		task(m === 'house' ? 'Dealing…' : m === 'quick' ? 'Joining the queue…' : 'Opening a game…', async () => {
			await ensureCards()
			if (active()) await leave()
			const opts = { name: playerName, as: 'person', ruleset: record.ruleset }
			if (m === 'house') {
				const s = Math.max(800, Math.min(1600, Math.round(record.rating)))
				adopt(await sc.games.startHouse({ ...opts, strength: s }), m, { strength: s })
			} else if (m === 'quick') {
				adopt(await sc.games.quickMatch({ ...opts, opponent: 'any' }), m)
			} else {
				// no opponentName: the friend's own name shows once they open the link
				const g = await sc.games.createDuel({ ...opts, opponent: 'person' })
				adopt(g, m, { inviteUrl: g.inviteUrl })
				copy(g.inviteUrl, 'Invite link copied. Send it to a friend.')
			}
		})
	}

	function resign() {
		if (!active()) return
		if (!game.waiting && !confirmClick('resign', 'Click Resign again to concede the game.')) return
		task(game.waiting ? 'Calling it off…' : 'Resigning…', async () => {
			const wasWaiting = game.waiting
			await leave()
			if (wasWaiting) say('Called off.')
		})
	}

	// Resign a game in play (it counts as a loss), or call off one nobody joined (back to the lobby).
	async function leave() {
		if (game.waiting) {
			await game.resign().catch(() => {})
			pumpGen++
			game = null
			mode = null
			inviteUrl = null
			saveRecord({ active: null })
			return
		}
		const before = owners()
		resigned = true
		await game.resign()
		afterChange(before)
	}

	function play(name) {
		const m = parseMove(name)
		const card = selected == null ? null : view()?.hand[selected]
		if (card?.kind === 'character' && m.cells.length === 1) pending = { cell: m.cells[0], card: card.card }
		selected = null
		path = []
		task(mode === 'house' ? `${opponentName()} is thinking…` : `Playing ${name}…`, async () => {
			const before = owners()
			try {
				await game.play(name)
			} finally {
				pending = null
			}
			afterChange(before)
		})
	}

	function clickHand(i) {
		const v = view()
		if (!v || !game.yourTurn || busy || v.pendingHop) return
		const card = v.hand[i]
		if (!card) return
		if (!playable(card)) return say(`${card.card} has nothing to do right now.`)
		if (selected === i) {
			const now = candidates().find((m) => m.cells.length === 0)
			if (now) return play(now.name)
			selected = null
		} else selected = i
		path = []
		render()
	}

	function clickCell(cell) {
		if (!game?.yourTurn || busy) return
		if (!targets().has(cell)) {
			if (path.length) {
				path = []
				render()
			}
			return
		}
		path = [...path, cell]
		const done = candidates().find((m) => m.cells.length === path.length && m.cells.every((c, i) => c === path[i]))
		if (done) return play(done.name)
		render()
	}

	function copy(text, okText) {
		navigator.clipboard?.writeText(text).then(
			() => say(okText),
			() => say('Click "Copy invite link" to copy it.')
		)
	}

	function openLink(url) {
		const w = window.open(url, '_blank', 'noopener')
		if (!w) copy(url, 'Replay link copied.')
	}

	function toggleRules() {
		showRules = !showRules
		if (showRules && !rulesText) {
			task('Fetching the rules…', async () => {
				rulesText = await sc.rules()
			})
		} else render()
	}

	function toggleRuleset() {
		saveRecord({ ruleset: record.ruleset === 'mutators' ? 'classic' : 'mutators' })
		say(active() ? 'The next game uses these rules.' : `Rules: ${record.ruleset === 'mutators' ? 'Mutators' : 'Classic'}.`)
		render()
	}

	/* ------------------------------- game updates ------------------------------- */

	// After any new state: mark what changed, finish the game, and wait for the other side.
	function afterChange(before) {
		const after = owners()
		flash = new Set([...after].filter(([cell, v]) => before.get(cell) !== v).map(([cell]) => cell))
		if (before.size === 0) flash = new Set()
		if (game.over) finish()
		else {
			if (view() && view().drawPile === 0) refreshOpponentHand()
			pump()
		}
		render()
	}

	async function refreshOpponentHand() {
		try {
			const s = await game.sync({ since: game.state.moveCount })
			opponentHand = s.state.opponentHand
			render()
		} catch {}
	}

	// Long-poll until it is your turn (or the game ends). One pump at a time.
	async function pump() {
		const gen = ++pumpGen
		while (!disposed && gen === pumpGen && game && !game.over && !game.yourTurn) {
			const before = owners()
			try {
				await game.waitForTurn(20)
			} catch (e) {
				if (disposed || gen !== pumpGen) return
				say(errorText(e), 5000)
				await new Promise((r) => setTimeout(r, 4000))
				continue
			}
			if (disposed || gen !== pumpGen) return
			if (game.over || game.yourTurn || owners().size !== before.size) {
				afterChange(before)
				return
			}
			render()
		}
	}

	async function finish() {
		if (finishedId === game.id) return
		finishedId = game.id
		const id = game.id
		const won = game.winner === 'you'
		if (game.state.status === 'finished') {
			const patch = { played: record.played + 1, won: record.won + (won ? 1 : 0), active: null }
			if (mode === 'house') {
				const score = won ? 1 : game.winner === 'draw' ? 0.5 : 0
				const expected = 1 / (1 + 10 ** ((strength - record.rating) / 400))
				patch.rating = Math.round(record.rating + 32 * (score - expected))
			}
			saveRecord(patch)
		} else saveRecord({ active: null })
		if (game.state.moveCount > 0) {
			try {
				const r = await game.review()
				if (game?.id === id) review = r
			} catch {}
			render()
		}
	}

	/* --------------------------------- drawing ---------------------------------- */

	const sid = (k) => createShapeId(`sc-${k}`)
	const assetsNeeded = new Map()

	function assetFor(url, w, h) {
		const id = AssetRecordType.createId(`sc-${url.replace(/^.*\//, '').replace(/[^a-z0-9]+/gi, '-')}`)
		assetsNeeded.set(id, { url, w, h })
		return id
	}

	function geo(k, x, y, w, h, o = {}) {
		return {
			id: sid(k),
			type: 'geo',
			x,
			y,
			rotation: 0,
			opacity: o.opacity ?? 1,
			isLocked: true,
			props: {
				geo: o.geo ?? 'rectangle',
				w,
				h,
				color: o.color ?? 'grey',
				labelColor: o.labelColor ?? 'black',
				fill: o.fill ?? 'none',
				dash: o.dash ?? 'solid',
				size: o.size ?? 'm',
				font: 'sans',
				align: o.align ?? 'middle',
				verticalAlign: o.valign ?? 'middle',
				richText: toRichText(o.label ?? ''),
			},
		}
	}

	function text(k, x, y, label, o = {}) {
		return {
			id: sid(k),
			type: 'text',
			x,
			y,
			rotation: 0,
			opacity: o.opacity ?? 1,
			isLocked: true,
			props: { richText: toRichText(label), size: o.size ?? 'm', font: 'sans', color: o.color ?? 'black', textAlign: o.align ?? 'start', autoSize: o.w == null, w: o.w ?? 8 },
		}
	}

	// A card image; an opponent's card is turned round (its values read from the board's far side).
	function image(k, x, y, w, h, url, o = {}) {
		const turned = !!o.turned
		return {
			id: sid(k),
			type: 'image',
			x: turned ? x + w : x,
			y: turned ? y + h : y,
			rotation: turned ? Math.PI : 0,
			opacity: o.opacity ?? 1,
			isLocked: true,
			props: { assetId: assetFor(url, o.iw ?? 563, o.ih ?? 768), w, h },
		}
	}

	function tilePos(cell) {
		const c = COLS.indexOf(cell[0])
		const r = Number(cell[1])
		const flip = mySeat() === 'B' // seat B sits at row 3: turn the board so your side is nearest you
		const vx = flip ? 4 - c : c
		const vy = flip ? r - 1 : 3 - r
		return { x: BX + vx * (CW + GAP), y: BY + vy * (CH + GAP) }
	}

	function statusLines() {
		const v = view()
		const opp = opponentName()
		if (busy) return { main: busy }
		if (!game) {
			return {
				main: 'Pick a game to start.',
				detail: 'New game: play now, against an opponent at your level.\nQuick match: whoever is online.\nInvite a friend: they play you in their browser.',
			}
		}
		if (game.waiting) {
			if (mode === 'invite')
				return { main: 'Waiting for your friend…', detail: `Send them this link:\n${inviteUrl ?? ''}`, action: inviteUrl && { label: 'Copy invite link', onClick: () => copy(inviteUrl, 'Invite link copied.') } }
			return { main: 'Looking for an opponent…', detail: 'You are in the quick-match queue. Cancel to leave it.' }
		}
		if (game.over) {
			const s = v?.score ?? { you: 0, opponent: 0 }
			const main = game.state.status === 'abandoned' ? 'Game called off.' : resigned ? 'You resigned.' : game.winner === 'you' ? `You win, ${s.you}–${s.opponent}!` : game.winner === 'draw' ? `A draw, ${s.you}–${s.opponent}.` : `${opp} wins, ${s.opponent}–${s.you}.`
			const acc = review ? `Accuracy: you ${Math.round(review.accuracy[mySeat()])}%, ${opp} ${Math.round(review.accuracy[mySeat() === 'A' ? 'B' : 'A'])}%.` : game.state.status === 'abandoned' ? 'The game was called off.' : ''
			return { main, detail: acc, action: game.replayUrl && { label: 'Watch the replay', onClick: () => openLink(game.replayUrl) } }
		}
		if (!game.yourTurn) return { main: `${opp} is playing…` }
		if (v.pendingHop) {
			const stay = v.legalMoves.find((n) => n.startsWith('hop:'))
			const from = v.pendingHop.from
			const who = v.board.find((t) => t.cell === from)?.card ?? 'Your card'
			const piece = v.special?.chessTiles.find((t) => t.cell === from)?.piece ?? 'chess piece'
			return {
				main: 'Hop! Pick a green tile.',
				detail: `${who} landed on a ${piece} tile: it may hop like a ${piece} and attack again.`,
				action: stay && { label: `Stay on ${v.pendingHop.from}`, onClick: () => play(stay) },
			}
		}
		const card = selected == null ? null : v.hand[selected]
		if (!card) return { main: 'Your turn. Pick a card.' }
		if (card.kind === 'character') return { main: `Place ${card.card} on a green tile.`, detail: 'Click the card again to put it back.' }
		const now = candidates().find((m) => m.cells.length === 0)
		if (now) return { main: `Click ${card.card} again to play it.`, detail: card.does, action: { label: `Play ${card.card}`, onClick: () => play(now.name) } }
		if (path.length) return { main: 'Now pick an empty tile for it.', detail: card.does }
		return { main: `${card.card} Pick a green tile.`, detail: card.does }
	}

	function scene() {
		const out = [] // [shape, layer, onClick?]
		const add = (shape, layer = 0, onClick) => out.push([shape, layer, onClick])
		const v = view()
		const mutators = (v?.ruleset ?? record.ruleset) === 'mutators'
		const yourTurn = !!game?.yourTurn && !busy

		// header
		add(image('logo', 0, 6, 84, 84, LOGO, { iw: 500, ih: 500 }))
		add(text('title', 100, 14, 'Smash&Clash', { size: 'xl' }))
		add(text('subtitle', 102, 76, `Played through the Smash&Clash SDK · ${mutators ? 'Mutators' : 'Classic'} rules`, { size: 's', color: 'grey' }))

		// the other side: name and face-down hand
		if (game && !game.waiting) {
			add(text('opp-name', 0, 116, opponentName(), { size: 'l', color: THEM }))
			add(text('opp-sub', 2, 166, mode === 'house' ? `Rating ${strength}` : 'Online', { size: 's', color: 'grey' }))
			const n = game.over ? 0 : opponentHand
			for (let i = 0; i < n; i++) add(image(`opp-back-${i}`, BOARD_W - (n - i) * (BACK_W + 8) + 8, 104, BACK_W, BACK_H, CARD_BACK, { iw: 825, ih: 1125 }))
		}

		// the board
		const tiles = new Map((v?.board ?? []).map((t) => [t.cell, t]))
		const chess = new Map((v?.special?.chessTiles ?? []).map((t) => [t.cell, t.piece]))
		const power = new Map((v?.special?.powerTiles ?? []).map((t) => [t.cell, t]))
		const overrun = new Set(v?.special?.overrunZones ?? [])
		const lit = targets()
		for (let r = 1; r <= 3; r++) {
			for (let c = 0; c < 5; c++) {
				const cell = `${COLS[c]}${r}`
				const { x, y } = tilePos(cell)
				const t = tiles.get(cell)
				const p = power.get(cell)
				const piece = chess.get(cell)
				const lines = []
				if (piece) lines.push(`${PIECE[piece] ?? ''} ${piece}`)
				if (p) lines.push(`+${p.boost} ${p.color}`)
				if (mutators && overrun.has(cell) && !piece && !p) lines.push('overrun')
				add(
					geo(`tile-${cell}`, x, y, CW, CH, {
						color: p ? POWER_COLOR[p.color] ?? 'grey' : 'grey',
						fill: p ? 'pattern' : 'semi',
						dash: mutators && overrun.has(cell) ? 'dashed' : 'solid',
						size: 's',
						label: t?.card ? '' : lines.join('\n'),
						labelColor: p ? POWER_COLOR[p.color] ?? 'grey' : piece ? 'violet' : 'grey',
					}),
					0,
					() => clickCell(cell)
				)
				const card = t?.card ?? (pending?.cell === cell ? pending.card : null)
				const owner = t?.owner ?? 'you'
				if (card && cards.has(card)) {
					add(geo(`frame-${cell}`, x, y, CW, CH, { color: owner === 'you' ? YOU : THEM, fill: 'fill', opacity: pending?.cell === cell ? 0.5 : 1 }), 1)
					add(image(`card-${cell}`, x + 5, y + 5, CW - 10, CH - 10, cards.get(card).image, { turned: owner !== 'you', opacity: pending?.cell === cell ? 0.7 : 1 }), 2)
					if (t?.frozen) {
						add(geo(`frost-${cell}`, x + 5, y + 5, CW - 10, CH - 10, { color: 'light-blue', fill: 'solid', opacity: 0.45 }), 3)
						add(text(`frost-label-${cell}`, x, y + CH / 2 - 14, 'FROZEN', { size: 's', color: 'blue', align: 'middle', w: CW }), 5)
					}
					if (piece) add(geo(`chess-${cell}`, x + 6, y + 6, 36, 36, { geo: 'ellipse', color: 'violet', fill: 'solid', size: 's', label: PIECE[piece] ?? '' }), 3)
				}
				if (p && card) add(geo(`power-${cell}`, x + CW - 54, y + 6, 48, 48, { geo: 'ellipse', color: POWER_COLOR[p.color] ?? 'grey', fill: 'fill', size: 's', label: `+${p.boost}`, labelColor: 'white' }), 3)
				if (lit.has(cell)) add(geo(`lit-${cell}`, x + 3, y + 3, CW - 6, CH - 6, { color: 'green', size: 'xl' }), 4)
				else if (path.includes(cell)) add(geo(`lit-${cell}`, x, y, CW, CH, { color: 'green', fill: 'solid', opacity: 0.5, size: 'xl' }), 4)
				if (flash.has(cell) && !lit.has(cell)) add(geo(`flash-${cell}`, x - 3, y - 3, CW + 6, CH + 6, { color: 'violet', size: 'l', dash: 'dashed' }), 4)
			}
		}
		// coordinates, so move names read on the board
		for (let c = 0; c < 5; c++) {
			const cell = `${COLS[c]}1`
			add(text(`col-${c}`, tilePos(cell).x, BY + BOARD_H + 6, COLS[c], { size: 's', color: 'grey', align: 'middle', w: CW }))
		}
		for (let r = 1; r <= 3; r++) add(text(`row-${r}`, BX - 30, tilePos(`A${r}`).y + CH / 2 - 14, String(r), { size: 's', color: 'grey' }))

		// your hand
		const hand = v?.hand ?? []
		hand.forEach((card, i) => {
			const x = BX + i * (CW + GAP)
			const sel = selected === i
			const y = HAND_Y - (sel ? 22 : 0)
			const dim = yourTurn && !v.pendingHop && !playable(card)
			const art = cards.get(card.card)?.image
			add(geo(`hand-${i}`, x, y, CW, CH, { color: sel ? 'green' : YOU, fill: 'fill', opacity: dim ? 0.4 : 1 }), 1, () => clickHand(i))
			if (art) add(image(`hand-card-${i}`, x + 5, y + 5, CW - 10, CH - 10, art, { opacity: dim ? 0.45 : 1 }), 2)
		})
		if (v) add(text('you-label', BX, HAND_Y + CH + 12, `${playerName} · Deck ${v.drawPile}`, { size: 's', color: YOU }))

		// the side panel: every part has a fixed slot, so a button never moves under the pointer
		// between a click and the click that confirms it
		let py = BY
		const st = statusLines()
		const noticeText = notice && notice.until > Date.now() ? notice.text : null
		add(geo('status', PX, py, PW, 110, { color: 'blue', fill: 'solid', label: st.main, align: 'start', size: 'm' }))
		py += 122
		const detail = noticeText ?? st.detail
		if (detail) add(text('detail', PX + 4, py, detail, { size: 's', w: PW - 8, color: noticeText ? 'red' : 'black' }))
		py += 112
		if (st.action) add(geo('action', PX, py, PW, 70, { color: 'green', fill: 'fill', labelColor: 'white', label: st.action.label }), 1, st.action.onClick)
		py += 82
		if (game && !game.waiting && v) {
			const mine = game.yourTurn && !game.over
			const theirs = !game.yourTurn && !game.over
			add(geo('score-you', PX, py, PW / 2 - 6, 70, { color: YOU, fill: mine ? 'fill' : 'semi', labelColor: mine ? 'white' : 'black', label: `You  ${v.score.you}`, size: 's' }))
			add(geo('score-them', PX + PW / 2 + 6, py, PW / 2 - 6, 70, { color: THEM, fill: theirs ? 'fill' : 'semi', labelColor: theirs ? 'white' : 'black', label: `${v.score.opponent}  ${short(opponentName(), 11)}`, size: 's' }))
		}
		py += 86
		// the buttons, two to a row
		const BW = (PW - 12) / 2
		let slot = 0
		const button = (k, label, onClick, o = {}) => {
			const off = o.disabled
			const x = PX + (slot % 2) * (BW + 12)
			const y = py + Math.floor(slot / 2) * 72
			slot++
			add(geo(`btn-${k}`, x, y, BW, 60, { color: off ? 'grey' : o.color ?? 'black', fill: off ? 'none' : 'solid', labelColor: off ? 'grey' : 'black', size: 's', label, dash: off ? 'dotted' : 'solid' }), 1, off ? undefined : onClick)
		}
		const armedKey = armed && armed.until > Date.now() ? armed.key : null
		const confirmLabel = 'Click to confirm'
		button('new', armedKey === 'start-house' ? confirmLabel : 'New game', () => startGame('house'), { color: 'blue' })
		button('quick', armedKey === 'start-quick' ? confirmLabel : 'Quick match', () => startGame('quick'))
		button('invite', armedKey === 'start-invite' ? confirmLabel : 'Invite a friend', () => startGame('invite'))
		button('resign', game?.waiting ? 'Cancel' : armedKey === 'resign' ? confirmLabel : 'Resign', resign, { disabled: !active(), color: 'red' })
		button('ruleset', `Rules: ${record.ruleset === 'mutators' ? 'Mutators' : 'Classic'}`, toggleRuleset, { color: 'violet' })
		button('how', showRules ? 'Hide how to play' : 'How to play', toggleRules)
		py += Math.ceil(slot / 2) * 72
		add(text('record', PX + 4, py + 4, `Rating ${record.rating} · ${record.played} played · ${record.won} won${game?.state.lastMove ? `\nLast move: ${game.state.lastMove}` : ''}`, { size: 's', color: 'grey', w: PW - 8 }))

		if (showRules && rulesText) {
			add(geo('rules', PX + PW + 40, BY, 480, BOARD_H, { color: 'grey', fill: 'solid', size: 's', align: 'start', valign: 'start', label: rulesText }), 1, toggleRules)
		}
		return out
	}

	function render() {
		if (disposed) return
		let items
		assetsNeeded.clear()
		try {
			items = scene()
		} catch (e) {
			console.error('[smashandclash] drawing failed', e)
			return
		}
		clickables = items.filter(([, , onClick]) => onClick).sort((a, b) => b[1] - a[1]).map(([s, , onClick]) => ({ id: s.id, onClick }))
		helpers.renderEphemeral(() =>
			editor.run(
				() => {
					const newAssets = [...assetsNeeded]
						.filter(([id]) => !editor.getAsset(id))
						.map(([id, a]) => ({ id, typeName: 'asset', type: 'image', meta: {}, props: { name: a.url.replace(/^.*\//, ''), src: a.url, w: a.w, h: a.h, mimeType: null, isAnimated: false } }))
					if (newAssets.length) editor.createAssets(newAssets)
					const keep = new Set()
					const create = []
					const update = []
					for (const [shape] of items) {
						keep.add(shape.id)
						const json = JSON.stringify(shape)
						if (!editor.getShape(shape.id)) create.push(shape)
						else if (live.get(shape.id) !== json) update.push(shape)
						live.set(shape.id, json)
					}
					const gone = [...live.keys()].filter((id) => !keep.has(id))
					for (const id of gone) live.delete(id)
					if (gone.length) editor.deleteShapes(gone.filter((id) => editor.getShape(id)))
					if (create.length) editor.createShapes(create)
					if (update.length) editor.updateShapes(update)
					if (create.length) {
						for (const layer of [1, 2, 3, 4, 5]) {
							const ids = items.filter(([, l]) => l === layer).map(([s]) => s.id)
							if (ids.length) editor.bringToFront(ids)
						}
					}
				},
				{ history: 'ignore', ignoreShapeLock: true }
			)
		)
	}

	/* ---------------------------------- input ----------------------------------- */

	function onEvent(info) {
		if (info?.type !== 'pointer' || info.name !== 'pointer_down' || (info.button ?? 0) !== 0) return
		if (editor.getCurrentToolId() !== 'select') return
		const point = editor.screenToPage(info.point)
		for (const { id, onClick } of clickables) {
			if (editor.getShape(id) && editor.isPointInShape(id, point, { hitInside: true })) {
				// out of the event dispatch: renderEphemeral cannot run inside the editor's own batch
				setTimeout(onClick, 0)
				return
			}
		}
	}

	// Ephemeral shapes outlive a script rerun, so each run clears what the last one drew.
	function clearDrawn() {
		const ids = [...editor.getCurrentPageShapeIds()].filter((id) => id.startsWith('shape:sc-'))
		if (ids.length) helpers.renderEphemeral(() => editor.run(() => editor.deleteShapes(ids), { history: 'ignore', ignoreShapeLock: true }))
		live.clear()
	}

	editor.on('event', onEvent)
	signal.addEventListener('abort', () => {
		disposed = true
		pumpGen++
		editor.off('event', onEvent)
		try {
			clearDrawn()
		} catch {}
	})

	/* ---------------------------------- start ----------------------------------- */

	clearDrawn()
	render()
	editor.zoomToBounds({ x: BX - 60, y: -10, w: PX + PW + 100, h: HAND_Y + CH + 70 }, { animation: { duration: 300 } })

	task('Shuffling the deck…', async () => {
		await ensureCards()
		const a = record.active
		if (!a?.id || !a.token) return
		try {
			const g = await sc.games.resume(a.id, a.token)
			pumpGen++
			game = g
			mode = a.mode ?? 'house'
			strength = a.strength ?? strength
			inviteUrl = a.inviteUrl ?? null
			afterChange(new Map())
		} catch {
			saveRecord({ active: null })
		}
	})
}
