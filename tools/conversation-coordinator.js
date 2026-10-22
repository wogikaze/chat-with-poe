export class ConversationCoordinator {
    constructor({ shouldReply, generate, deliver, onError, quietMs = 1200, maxWaitMs = 4000,
        maxBatchMessages = 32, maxConversations = 64 }) {
        Object.assign(this, { shouldReply, generate, deliver, onError, quietMs, maxWaitMs,
            maxBatchMessages, maxConversations });
        this.states = new Map();
        this.accepting = true;
    }

    has(key) { return this.states.has(key); }

    suppress(key) {
        const state = this.states.get(key);
        if (state) {
            state.suppressed = true;
            state.pending.length = 0;
        }
    }

    submit(key, message, { invited = false } = {}) {
        if (!this.accepting) return false;
        let state = this.states.get(key);
        if (!state) {
            if (this.states.size >= this.maxConversations) return false;
            state = { pending: [], suppressed: false, firstAt: Date.now(), lastAt: Date.now() };
            this.states.set(key, state);
        }
        if (state.pending.length >= this.maxBatchMessages) return false;
        if (!state.pending.length) state.firstAt = Date.now();
        state.lastAt = Date.now();
        if (invited) state.suppressed = false;
        state.pending.push(message);
        if (!state.work) {
            state.work = this.process(state).catch(error => this.onError(error, message))
                .finally(() => this.states.delete(key));
        }
        return true;
    }

    async waitForBatch(state) {
        while (this.accepting && state.pending.length < this.maxBatchMessages) {
            const remaining = Math.min(state.lastAt + this.quietMs, state.firstAt + this.maxWaitMs) - Date.now();
            if (remaining <= 0) break;
            await new Promise(resolve => setTimeout(resolve, remaining));
        }
        return state.pending.splice(0);
    }

    async process(state) {
        while (state.pending.length) {
            let batch = await this.waitForBatch(state);
            try {
                if (state.suppressed || !(await this.shouldReply(batch))) continue;
                let answer = await this.generate(batch);
                if (state.suppressed) continue;
                // Exactly one revision per batch. Arrivals during that revision become
                // the next batch, so sustained activity cannot postpone this delivery.
                if (state.pending.length) {
                    batch = [...batch, ...await this.waitForBatch(state)];
                    if (state.suppressed) continue;
                    answer = await this.generate(batch);
                }
                if (!state.suppressed) await this.deliver(batch.at(-1), answer);
            } catch (error) {
                await this.onError(error, batch.at(-1));
            }
        }
    }

    async close() {
        this.accepting = false;
        await Promise.allSettled([...this.states.values()].map(state => state.work));
    }
}
