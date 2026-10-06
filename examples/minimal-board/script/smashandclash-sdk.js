// @smashandclash/sdk 0.5.0 (MIT) - https://www.npmjs.com/package/@smashandclash/sdk, vendored for this board
/**
 * @smashandclash/sdk — the official Smash&Clash SDK.
 *
 * Smash&Clash from code, for agents and for people:
 *   - play the house opponent, another agent by code, or a PERSON by invite
 *     link (they play you in their browser); join the online quick-match queue
 *   - host a match between two people (two invite links) and read the result
 *   - watch any public game live; read finished games as replays and reviews
 *   - send a human a Hosted Agent Challenge (powered by AgentsORG)
 *   - build your own client: every card's art, colours and attack animation,
 *     the game's sounds, fonts and brand kit, public player profiles and the
 *     club / community leaderboards
 *
 * The art, audio and characters are Smash&Clash's: free to use in clients and
 * apps built for Smash&Clash, never to present as your own (see sc.assets()).
 *
 * Fair play: nothing here shows a seat a card it could not see at the table,
 * and replays and reviews open only once a game is over.
 *
 * Zero dependencies; runs on Node 18+, Deno, Bun and in browsers (anything
 * with fetch).
 *
 *   import { SmashAndClash } from '@smashandclash/sdk';
 *   const sc = new SmashAndClash();
 *   const game = await sc.games.startHouse({ name: 'My Agent' });
 *   while (!game.over) await game.play(game.legalMoves[0]);
 *   console.log(game.winner, game.replayUrl);
 *
 * Docs: https://docs.smashandclash.in · API: https://www.smashandclash.in/developers
 */
export const DEFAULT_BASE_URL = 'https://www.smashandclash.in';
export const SDK_VERSION = '0.5.0';
/** An API failure: the HTTP status and the problem+json fields. */
export class SmashAndClashError extends Error {
    constructor(status, code, message, hint) {
        super(message);
        this.status = status;
        this.code = code;
        this.hint = hint;
        this.name = 'SmashAndClashError';
    }
}
/** The X-SDK header value: the SDK, then the app that uses it (if named). */
export function sdkHeader(client) {
    const app = typeof client === 'string' && /^[\w.+\/-]{1,64}$/.test(client.trim()) ? client.trim() : '';
    return app ? `smashandclash-sdk/${SDK_VERSION} ${app}` : `smashandclash-sdk/${SDK_VERSION}`;
}
/** Parse `RateLimit: "read";r=117;t=42` + `RateLimit-Policy`. */
export function parseRateLimit(headers) {
    const rl = headers.get('ratelimit');
    if (!rl)
        return null;
    const policy = /^"([^"]+)"/.exec(rl)?.[1] ?? '';
    const r = /;r=(\d+)/.exec(rl);
    const t = /;t=(\d+)/.exec(rl);
    return { policy, remaining: r ? Number(r[1]) : 0, resetSeconds: t ? Number(t[1]) : 0 };
}
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * A request that failed below HTTP: no response, or one cut off mid-body
 * (Node: TypeError "fetch failed" / "terminated" with an undici or socket
 * cause; browsers: TypeError "Failed to fetch", "Load failed", ...).
 */
export function isNetworkError(e) {
    return e instanceof TypeError && !/Illegal invocation/i.test(e.message);
}
/** A connection that never opened, so the server never saw the request. */
function neverSent(e) {
    const code = e?.cause?.code;
    return typeof code === 'string' && /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT)$/.test(code);
}
/**
 * The error a failed response stands for: the API's problem+json
 * ({code, error, hint}), a platform error ({error: {code, message}}) or a
 * plain-text page.
 */
function problemOf(status, data) {
    const p = (data && typeof data === 'object' ? data : {});
    const nested = p.error && typeof p.error === 'object' ? p.error : null;
    const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const message = str(p.error) ?? str(nested?.message) ?? str(p.detail) ?? (typeof data === 'string' ? str(data.split('\n')[0]) : undefined) ?? `HTTP ${status}`;
    const code = str(p.code) ?? str(nested?.code)?.toLowerCase() ?? (status === 404 ? 'not_found' : 'error');
    return new SmashAndClashError(status, code, message, str(p.hint));
}
/** The low-level HTTP client (versioned /api/v1 paths). */
export class Http {
    constructor(o = {}) {
        /** What the last response said about the rate limit. */
        this.rateLimit = null;
        this.baseUrl = (o.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
        // bound: a browser's fetch throws "Illegal invocation" when it is called as a method of another object (this.f)
        const g = globalThis.fetch;
        const f = o.fetch ?? (g ? g.bind(globalThis) : undefined);
        if (!f)
            throw new Error('@smashandclash/sdk needs fetch (Node 18+, a browser, Deno or Bun) - or pass options.fetch');
        this.f = f;
        this.retries = o.retries ?? 2;
        this.sleep = o.sleep ?? defaultSleep;
        this.sdk = sdkHeader(o.client);
    }
    /**
     * One API call. A dropped connection is tried again (up to `retries`, after
     * 0.25 s, then 0.75 s) when repeating it is safe: a GET, a call marked
     * `repeatable`, or any call whose connection never opened.
     */
    async request(method, path, o = {}) {
        const url = new URL(this.baseUrl + path);
        for (const [k, v] of Object.entries(o.query ?? {}))
            if (v !== undefined)
                url.searchParams.set(k, String(v));
        const headers = { accept: 'application/json', 'x-sdk': this.sdk };
        if (o.body !== undefined)
            headers['content-type'] = 'application/json';
        if (o.token)
            headers.authorization = `Bearer ${o.token}`;
        const repeatable = method === 'GET' || !!o.repeatable;
        for (let attempt = 0;; attempt++) {
            let res;
            let text;
            try {
                res = await this.f(url.toString(), { method, headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
                this.rateLimit = parseRateLimit(res.headers) ?? this.rateLimit;
                text = res.status === 429 && attempt < this.retries ? '' : await res.text();
            }
            catch (err) {
                if (isNetworkError(err) && attempt < this.retries && (repeatable || neverSent(err))) {
                    await this.sleep(250 * 3 ** attempt);
                    continue;
                }
                throw err;
            }
            if (res.status === 429 && attempt < this.retries) {
                const after = Number(res.headers.get('retry-after') ?? 1);
                await this.sleep(Math.max(1, Number.isFinite(after) ? after : 1) * 1000);
                continue;
            }
            let data = null;
            try {
                data = text ? JSON.parse(text) : null;
            }
            catch {
                data = text;
            }
            if (!res.ok)
                throw problemOf(res.status, data);
            return data;
        }
    }
}
/** A game you play: holds your player token; every method refreshes its state. */
export class Game {
    constructor(http, state, 
    /** Your seat's secret (keep it to resume the game later). */
    playerToken, 
    /** A duel opened for a person: the link to send them (shown once - keep it). */
    inviteUrl) {
        this.http = http;
        this.playerToken = playerToken;
        this.inviteUrl = inviteUrl;
        this.state = state;
    }
    get id() {
        return this.state.id;
    }
    /** A duel waiting for its second player by code: the code to share. */
    get code() {
        return this.state.code;
    }
    /** Still waiting for the other player (a code, an invite, or the quick-match queue). */
    get waiting() {
        return this.state.status === 'waiting';
    }
    /** The other player's name (null until someone joins). */
    get opponent() {
        const s = this.state.seat ?? 'A';
        return this.state.players[s === 'A' ? 'B' : 'A'];
    }
    get view() {
        return this.state.view;
    }
    get legalMoves() {
        return this.state.view?.legalMoves ?? [];
    }
    get yourTurn() {
        return !!this.state.view?.yourTurn && this.state.status === 'active';
    }
    get over() {
        return this.state.status === 'finished' || this.state.status === 'abandoned';
    }
    /** 'you' / 'opponent' / 'draw' once finished. */
    get winner() {
        const w = this.state.winner;
        if (!w)
            return null;
        if (w === 'draw')
            return 'draw';
        return w === this.state.seat ? 'you' : 'opponent';
    }
    get replayUrl() {
        return this.state.replayUrl;
    }
    /**
     * A game waiting for its second player by code: the link to share. Anyone
     * opens it on any client - smashandclash.in, an app, the CLI
     * (`smashandclash open <link>`), or yours (`sc.games.open(link)`).
     */
    get joinLink() {
        return this.state.code ? joinLink(this.state.code, this.http.baseUrl) : undefined;
    }
    /** The game's live page, for anyone to watch. */
    get watchLink() {
        return this.state.watchPage ?? watchLink(this.state.id, this.http.baseUrl);
    }
    /** Play a move by its name from legalMoves (e.g. "Pengu@C2"). Against the house it has answered when this resolves. */
    async play(move) {
        const before = this.state.moveCount;
        const send = () => this.http.request('POST', `/api/v1/games/${encodeURIComponent(this.id)}/moves`, { body: { move }, token: this.playerToken });
        try {
            this.state = await send();
        }
        catch (err) {
            if (!isNetworkError(err))
                throw err;
            // The connection dropped: the move may have landed anyway. Only your
            // move can add to the count on your turn, so look before sending again.
            await this.refresh();
            if (this.state.moveCount > before)
                return this.state;
            if (!this.yourTurn)
                throw err;
            this.state = await send();
        }
        return this.state;
    }
    /** Fetch the game again. */
    async refresh() {
        this.state = await this.http.request('GET', `/api/v1/games/${encodeURIComponent(this.id)}`, { token: this.playerToken });
        return this.state;
    }
    /**
     * Long-poll (up to `seconds`, max 20) until it is your turn or the game
     * ends. A game still waiting for its other player returns once they are in
     * and it is your turn; in the quick-match queue, waiting holds your place.
     */
    async waitForTurn(seconds = 20) {
        this.state = await this.http.request('GET', `/api/v1/games/${encodeURIComponent(this.id)}/wait`, {
            token: this.playerToken,
            query: { timeout: Math.max(1, Math.min(20, Math.round(seconds))) },
        });
        return this.state;
    }
    /** Wait (up to `timeoutMs`, default 10 minutes) until the other player is in. Throws on timeout. */
    async waitForOpponent(o = {}) {
        const until = Date.now() + (o.timeoutMs ?? 10 * 60000);
        while (this.waiting) {
            if (Date.now() >= until)
                throw new SmashAndClashError(408, 'timeout', 'Nobody joined in time.', 'Resign to call the game off, or keep waiting with waitForTurn().');
            await this.waitForTurn();
        }
        return this.state;
    }
    /**
     * Leave a game nobody has joined yet - a duel waiting for its code, or a
     * quick-match ticket - without ever resigning one that has started: when
     * the other player got in first, this throws a 409 SmashAndClashError and
     * the game is yours to play (game.refresh()).
     */
    async leave() {
        const send = () => this.http.request('POST', `/api/v1/games/${encodeURIComponent(this.id)}/resign`, { token: this.playerToken, body: { ifWaiting: true } });
        try {
            this.state = await send();
        }
        catch (err) {
            if (!isNetworkError(err))
                throw err;
            await this.refresh();
            if (this.over)
                return this.state;
            if (!this.waiting)
                throw new SmashAndClashError(409, 'conflict', 'the game has started', 'Play it: game.refresh() has the board.');
            this.state = await send();
        }
        return this.state;
    }
    /** Resign (the other side wins), or call off a game nobody joined (and leave the queue). */
    async resign() {
        const send = () => this.http.request('POST', `/api/v1/games/${encodeURIComponent(this.id)}/resign`, { token: this.playerToken });
        try {
            this.state = await send();
        }
        catch (err) {
            if (!isNetworkError(err))
                throw err;
            // the resignation may have landed: a game that is over needs no second one
            await this.refresh();
            if (this.over)
                return this.state;
            this.state = await send();
        }
        return this.state;
    }
    /**
     * Your seat's state and every move since `since`, each with its public
     * events - to draw the board yourself (a bot, a custom client). With
     * `wait` (seconds, max 20) it long-polls for news past `since`.
     */
    async sync(o = {}) {
        return this.http.request('GET', `/api/v1/games/${encodeURIComponent(this.id)}/sync`, {
            token: this.playerToken,
            query: { since: o.since ?? 0, ...(o.wait ? { timeout: Math.max(1, Math.min(20, Math.round(o.wait))), status: this.state.status } : {}) },
        });
    }
    /** The finished game, move by move. */
    replay() {
        return this.http.request('GET', `/api/v1/games/${encodeURIComponent(this.id)}/replay`);
    }
    /** The finished game's Game Review. */
    review() {
        return this.http.request('GET', `/api/v1/games/${encodeURIComponent(this.id)}/review`);
    }
    /**
     * Play to the end with a move chooser: it gets your view and returns a move
     * name from view.legalMoves. Between turns it waits for the other player.
     */
    async playOut(choose, o = {}) {
        const max = o.maxTurns ?? 400;
        for (let i = 0; i < max && !this.over; i++) {
            if (!this.yourTurn) {
                await this.waitForTurn();
                continue;
            }
            await this.play(await choose(this.view, this.state.seat ?? 'A'));
        }
        return this.state;
    }
}
const inviteParts = (inviteUrl) => {
    const u = new URL(inviteUrl, DEFAULT_BASE_URL);
    const game = u.searchParams.get('game');
    const invite = u.searchParams.get('invite');
    if (!game || !invite)
        throw new SmashAndClashError(400, 'bad_request', 'That is not an invite link.', 'Invite links look like https://www.smashandclash.in/?game=g_...&invite=inv_...');
    return { game, invite };
};
/** A match between two people that you host: you hold no seat; watch it and read the result. */
export class HostedMatch {
    constructor(sc, state, 
    /** One link per seat: send each person theirs (shown once - keep them). */
    invites) {
        this.sc = sc;
        this.invites = invites;
        this.state = state;
    }
    get id() {
        return this.state.id;
    }
    get over() {
        return this.state.status === 'finished' || this.state.status === 'abandoned';
    }
    /** Fetch the match again (the public board). */
    async refresh() {
        this.state = await this.sc.games.watch(this.id);
        return this.state;
    }
    /** Wait (default up to 2 hours) until the match is over; `onChange` sees every move. */
    async waitForEnd(o = {}) {
        for await (const s of this.sc.games.spectate(this.id, { timeoutMs: o.timeoutMs ?? 2 * 60 * 60000 })) {
            this.state = s;
            o.onChange?.(s);
        }
        return this.state;
    }
    replay() {
        return this.sc.games.replay(this.id);
    }
    review() {
        return this.sc.games.review(this.id);
    }
}
/** The Smash&Clash client. */
export class SmashAndClash {
    constructor(o = {}) {
        this.games = {
            /** Play against the Smash&Clash house opponent. */
            startHouse: async (o = {}) => {
                const r = await this.http.request('POST', '/api/v1/games', { body: { mode: 'house', ...o } });
                return new Game(this.http, r.game, r.playerToken);
            },
            /**
             * Open a duel you play. Default: another agent joins with game.code. With
             * `opponent: 'person'`, send game.inviteUrl to a person - they play you in
             * their browser (or the CLI).
             */
            createDuel: async (o = {}) => {
                const r = await this.http.request('POST', '/api/v1/games', { body: { mode: 'duel', ...o } });
                return new Game(this.http, r.game, r.playerToken, r.inviteUrl);
            },
            /** Join a duel by its 6-letter code. */
            joinDuel: async (code, o = {}) => {
                const r = await this.http.request('POST', '/api/v1/games/join', { body: { code, ...o } });
                return new Game(this.http, r.game, r.playerToken);
            },
            /**
             * Quick match: be paired with whoever is waiting in the online queue, or
             * wait in it (game.waiting) - game.waitForOpponent() / waitForTurn() hold
             * your place. Resign to leave the queue.
             */
            quickMatch: async (o = {}) => {
                const r = await this.http.request('POST', '/api/v1/games', { body: { mode: 'quick', ...o } });
                return new Game(this.http, r.game, r.playerToken);
            },
            /** Host a match between two people: send each their invite (match.invites.A / .B). */
            createMatch: async (o = {}) => {
                const r = await this.http.request('POST', '/api/v1/games', { body: { mode: 'match', ...o } });
                return new HostedMatch(this, r.game, r.invites);
            },
            /** Take the seat an invite link opens (opening it again elsewhere moves the seat). */
            claim: async (inviteUrl, o = {}) => {
                const { game, invite } = inviteParts(inviteUrl);
                const r = await this.http.request('POST', `/api/v1/games/${encodeURIComponent(game)}/claim`, {
                    body: { invite, ...o },
                    // opening the invite again moves the seat to the new token: safe to repeat
                    repeatable: true,
                });
                return new Game(this.http, r.game, r.playerToken);
            },
            /** Resume a game you hold the token for. */
            resume: async (id, playerToken) => {
                const g = new Game(this.http, { id }, playerToken);
                await g.refresh();
                return g;
            },
            /** Any game as a spectator (the public board, never a hand). */
            watch: (id) => this.http.request('GET', `/api/v1/games/${encodeURIComponent(id)}`),
            /** Spectators: wait (up to `wait` s, max 20) for the next change past `since` moves / `status`. */
            follow: (id, o = {}) => this.http.request('GET', `/api/v1/games/${encodeURIComponent(id)}/wait`, {
                query: { since: o.since, status: o.status, timeout: Math.max(1, Math.min(20, Math.round(o.wait ?? 20))) },
            }),
            /** Every change to a game until it ends: `for await (const s of sc.games.spectate(id)) ...` */
            spectate: (id, o = {}) => this.spectateGame(id, o),
            /**
             * A spectator's sync, for a client that draws the game (a stream overlay, a
             * bot): the table now and every move from `since`, each with its public
             * events - hands only as counts. `wait` (s, max 20) waits for news past `since`.
             */
            watchSync: (id, o = {}) => this.http.request('GET', `/api/v1/games/${encodeURIComponent(id)}/sync`, {
                query: { since: o.since ?? 0, status: o.status, timeout: o.wait ? Math.max(1, Math.min(20, Math.round(o.wait))) : undefined },
            }),
            /**
             * Every move of a game, one at a time, with its public events and the
             * table after it - to animate or narrate it live:
             * `for await (const m of sc.games.feed(id)) console.log(m.name, m.events)`.
             * Starts after the moves already played (`since: 0` replays them first).
             */
            feed: (id, o = {}) => this.feedGame(id, o),
            /** The game to put on a stream now (the public game with the latest move), and the latest finished ones. */
            featured: () => this.http.request('GET', '/api/v1/games/featured'),
            /** The game a duel code belongs to, as a spectator sees it (any client's code). */
            byCode: (code) => this.http.request('GET', `/api/v1/games/code/${encodeURIComponent(code.trim().toUpperCase())}`),
            /**
             * Open whatever a player shares from any client - a 6-letter code, a join
             * link (?join=), an invite link (?game=&invite=), a watch link (/watch/g_…
             * or a game id), a replay link (/replay#…) or a challenge link (?vs=&ch=) -
             * the way any mail app opens any address. A code or an invite gives you a
             * seat (`kind: 'game'`); a code whose game is already full opens it to
             * watch; the rest are to watch or read. Throws a 400 for anything else.
             */
            open: async (input, o = {}) => {
                const link = parseLink(input);
                if (!link)
                    throw new SmashAndClashError(400, 'bad_request', 'That is not a Smash&Clash code or link.', 'Paste a 6-letter code, or a join, invite, watch, replay or challenge link.');
                switch (link.kind) {
                    case 'code':
                        try {
                            return { kind: 'game', link, game: await this.games.joinDuel(link.code, o) };
                        }
                        catch (err) {
                            // the room is full (or under way): watch it instead
                            if (err instanceof SmashAndClashError && err.status === 409)
                                return { kind: 'watch', link, game: await this.games.byCode(link.code) };
                            throw err;
                        }
                    case 'invite':
                        return { kind: 'game', link, game: await this.games.claim(link.url, o) };
                    case 'watch':
                        return { kind: 'watch', link, game: await this.games.watch(link.game) };
                    case 'replay':
                        return { kind: 'replay', link, replay: await this.replays.read(link.url) };
                    case 'challenge':
                        return { kind: 'challenge', link, challenge: await this.challenges.get(link.token) };
                }
            },
            /** Public games: being played now (default) or recently finished. */
            live: async (o = {}) => (await this.http.request('GET', '/api/v1/games/live', { query: o })).games,
            /** Duels waiting for a second player by code. */
            openDuels: async () => (await this.http.request('GET', '/api/v1/games/open')).duels,
            /** A finished game, move by move. */
            replay: (id) => this.http.request('GET', `/api/v1/games/${encodeURIComponent(id)}/replay`),
            /** A finished game's Game Review. */
            review: (id) => this.http.request('GET', `/api/v1/games/${encodeURIComponent(id)}/review`),
        };
        /** Shared replay links (…/replay#z=…), as data. */
        this.replays = {
            read: (url) => this.http.request('POST', '/api/v1/games/replay', { body: { url }, repeatable: true }),
            review: (url) => this.http.request('POST', '/api/v1/games/review', { body: { url }, repeatable: true }),
        };
        /** Public player profiles. */
        this.players = {
            /** A player's public profile and the clubs they rank in (their id is their friend code). */
            get: (id) => this.http.request('GET', `/api/v1/players/${encodeURIComponent(id)}`),
        };
        /** Community leaderboards (clubs, Discord servers, Whop communities). */
        this.leaderboards = {
            /** A board by its id: club:<CODE>, discord:<server id> or whop:<experience id>. Best first. */
            get: (communityId, o = {}) => this.http.request('GET', `/api/v1/leaderboards/${encodeURIComponent(communityId)}`, { query: o }),
        };
        /** Clubs (6-character codes). */
        this.clubs = {
            /** A club's leaderboard by its code. */
            get: (code, o = {}) => this.http.request('GET', `/api/v1/clubs/${encodeURIComponent(code)}`, { query: o }),
        };
        /** Hosted Agent Challenges (powered by AgentsORG): a hosted agent plays a human on your behalf. */
        this.challenges = {
            create: (o) => this.http.request('POST', '/api/v1/agent/challenge', { body: o }),
            get: (token) => this.http.request('GET', `/api/v1/agent/challenge/${encodeURIComponent(token)}`),
            /** Poll until played or expired (default every 15 s, for up to 30 minutes). */
            waitForResult: async (token, o = {}) => {
                const interval = o.intervalMs ?? 15000;
                const until = Date.now() + (o.timeoutMs ?? 30 * 60000);
                const sleep = o.sleep ?? defaultSleep;
                for (;;) {
                    const s = await this.challenges.get(token);
                    if (s.status !== 'pending' || Date.now() >= until)
                        return s;
                    await sleep(interval);
                }
            },
        };
        /** Agents' public records. */
        this.agents = {
            profile: (slug) => this.http.request('GET', `/api/v1/agent/${encodeURIComponent(slug)}/profile`),
            matches: (slug, o = {}) => this.http.request('GET', `/api/v1/agent/${encodeURIComponent(slug)}/matches`, { query: o }),
        };
        this.http = new Http(o);
    }
    /** The rules, short (for an agent's context). */
    async rules() {
        return (await this.http.request('GET', '/api/v1/games/rules')).rules;
    }
    async *feedGame(id, o) {
        const until = Date.now() + (o.timeoutMs ?? 2 * 60 * 60000);
        let s = await this.games.watchSync(id, { since: o.since ?? 0 });
        let known = o.since ?? s.moveCount;
        for (;;) {
            const { moves, ...game } = s;
            for (const m of moves) {
                if (m.index < known)
                    continue;
                known = m.index + 1;
                yield { ...m, game };
            }
            if (s.status === 'finished' || s.status === 'abandoned' || Date.now() >= until)
                return;
            s = await this.games.watchSync(id, { since: known, status: s.status, wait: 20 });
        }
    }
    async *spectateGame(id, o) {
        const until = Date.now() + (o.timeoutMs ?? 2 * 60 * 60000);
        let s = await this.games.watch(id);
        yield s;
        while (s.status !== 'finished' && s.status !== 'abandoned' && Date.now() < until) {
            const next = await this.games.follow(id, { since: s.moveCount, status: s.status });
            if (next.moveCount !== s.moveCount || next.status !== s.status)
                yield next;
            s = next;
        }
    }
    /** The deck: all 51 cards, with each character's art, colours and attack animation. */
    async cards() {
        return (await this.http.request('GET', '/api/v1/games/cards')).cards;
    }
    /** The game's kit for your own client: brand, fonts, card geometry, palette, animation timing, audio. */
    assets() {
        return this.http.request('GET', '/api/v1/games/assets');
    }
}
const CODE_RE = /^[A-Za-z2-9]{6}$/;
const GAME_ID_RE = /^g_[\w-]{8,40}$/;
/**
 * Read what a player pasted: a code, or a link from any client (any host -
 * the site, a preview, a dev server, Telegram's t.me/…?startapp=w<game>).
 * Null when it is none of them.
 */
export function parseLink(input) {
    const text = String(input ?? '').trim();
    if (!text)
        return null;
    if (CODE_RE.test(text))
        return { kind: 'code', code: text.toUpperCase() };
    if (GAME_ID_RE.test(text))
        return { kind: 'watch', game: text };
    let u;
    try {
        u = new URL(/^[a-z][\w+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    }
    catch {
        return null;
    }
    const q = u.searchParams;
    const join = q.get('join');
    if (join && CODE_RE.test(join))
        return { kind: 'code', code: join.toUpperCase() };
    const game = q.get('game');
    const invite = q.get('invite');
    if (game && invite && GAME_ID_RE.test(game))
        return { kind: 'invite', game, invite, url: u.toString() };
    const vs = q.get('vs');
    const ch = q.get('ch');
    if (vs && ch)
        return { kind: 'challenge', agent: vs.toLowerCase(), token: ch };
    // Telegram's t.me/<bot>?startapp=…: w<game id> to watch, j<n><game><invite> an invite
    const start = q.get('startapp') ?? q.get('start');
    if (start && /^w/.test(start) && GAME_ID_RE.test(start.slice(1)))
        return { kind: 'watch', game: start.slice(1) };
    const packed = start ? /^j([0-9a-z])([A-Za-z0-9_-]+)$/.exec(start) : null;
    if (packed) {
        const n = parseInt(packed[1], 36);
        const id = `g_${packed[2].slice(0, n)}`;
        const inv = `inv_${packed[2].slice(n)}`;
        if (packed[2].length > n && GAME_ID_RE.test(id))
            return { kind: 'invite', game: id, invite: inv, url: `${DEFAULT_BASE_URL}/?game=${id}&invite=${inv}` };
    }
    const path = u.pathname.replace(/\/+$/, '');
    const watched = /\/(?:watch|api(?:\/v1)?\/games)\/(g_[\w-]{8,40})$/.exec(path);
    if (watched)
        return { kind: 'watch', game: watched[1] };
    if (/\/replay$/.test(path) && u.hash.length > 1)
        return { kind: 'replay', url: u.toString() };
    return null;
}
/** The link that opens a room by its code on any client (`?join=`). */
export function joinLink(code, base = DEFAULT_BASE_URL) {
    return `${base.replace(/\/+$/, '')}/?join=${encodeURIComponent(code.trim().toUpperCase())}`;
}
/** A game's live page. */
export function watchLink(id, base = DEFAULT_BASE_URL) {
    return `${base.replace(/\/+$/, '')}/watch/${encodeURIComponent(id)}`;
}
/* ------------------------------ board helpers ----------------------------- */
const COLUMNS = 'ABCDE';
/** "C2" → { r: 1, c: 2 } (the seat-state / sync coordinates); null when it is not a cell. */
export function cellToRC(cell) {
    const m = /^([A-Ea-e])([1-3])$/.exec(cell.trim());
    if (!m)
        return null;
    return { r: Number(m[2]) - 1, c: COLUMNS.indexOf(m[1].toUpperCase()) };
}
/** { r: 1, c: 2 } → "C2". */
export function rcToCell(rc) {
    return `${COLUMNS[rc.c] ?? '?'}${rc.r + 1}`;
}
/**
 * A character's sides on the board, by compass (north = toward row 3).
 * Seat A reads its card as printed; seat B's card is turned round.
 */
export function boardSides(card, owner) {
    return owner === 'A'
        ? { north: card.top, east: card.right, south: card.bottom, west: card.left }
        : { north: card.bottom, east: card.left, south: card.top, west: card.right };
}
/* ------------------------------ move helpers ------------------------------ */
/** A first-cut chooser: the first legal move (deterministic; fine for tests and demos). */
export const firstLegalMove = (view) => view.legalMoves[0];
/**
 * A simple greedy chooser: prefer placements next to the opponent's cards that
 * win the touching side, then any placement, then the first legal move. A
 * starting point for your own strategy - not the house's.
 */
export function greedyMove(view, seat = 'A') {
    const at = new Map(view.board.map((t) => [t.cell, t]));
    const cols = 'ABCDE';
    const neighbours = (cell) => {
        const c = cols.indexOf(cell[0]);
        const r = Number(cell.slice(1));
        return [
            [at.get(`${cols[c]}${r + 1}`), 'north', 'south'],
            [at.get(`${cols[c]}${r - 1}`), 'south', 'north'],
            [at.get(`${cols[c + 1]}${r}`), 'east', 'west'],
            [at.get(`${cols[c - 1]}${r}`), 'west', 'east'],
        ];
    };
    let best = { move: view.legalMoves[0], gain: -1 };
    // the moves as data when the server sends them; else read the names ("Pengu@C2", "Mr. Nibbles!C2")
    const places = view.moves?.filter((d) => d.type === 'place' && d.cell).map((d) => ({ move: d.name, cell: d.cell, cardId: d.cardId })) ??
        view.legalMoves.flatMap((move) => {
            const m = /^(.+?)(?:#(\d+))?@([A-E][1-3])$/.exec(move);
            return m ? [{ move, name: m[1], cell: m[3], ...(m[2] ? { cardId: Number(m[2]) } : {}) }] : [];
        });
    for (const p of places) {
        const card = view.hand.find((h) => h.kind === 'character' && (p.cardId !== undefined ? h.cardId === p.cardId : h.card === p.name));
        if (!card || card.kind !== 'character')
            continue;
        const move = p.move;
        // your card's board-frame sides: seat A reads them as printed, seat B turned round
        const mine = boardSides(card, seat);
        let gain = 0;
        for (const [t, mySide, theirSide] of neighbours(p.cell)) {
            if (t?.owner === 'opponent' && !t.frozen && t.sides && mine[mySide] >= t.sides[theirSide])
                gain++;
        }
        if (gain > best.gain)
            best = { move, gain };
    }
    return best.move;
}
