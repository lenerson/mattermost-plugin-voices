/**
 * Call tones (Web Audio API): a double beep for an incoming call, and a
 * ringback for the caller while the far side is being rung.
 */

/**
 * Each ringer owns its AudioContext, so stopping one cannot silence the other,
 * and resumes it before playing — a context built before the page has seen a
 * user gesture starts suspended and would otherwise stay silent for good.
 *
 * Pulses are scheduled on the audio clock rather than with setTimeout, so the
 * cadence does not drift; closing the context is what cuts any pulse still in
 * flight when the call is answered.
 */
function createRinger({frequency, pulseMs, pulseCount, pulseGapMs, cycleMs, peak}) {
    let ctx = null;
    let cycleTimer = null;

    function schedulePulse(at) {
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        const seconds = pulseMs / 1000;

        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.value = 0.0001;
        oscillator.connect(gain);
        gain.connect(ctx.destination);

        oscillator.start(at);
        gain.gain.exponentialRampToValueAtTime(peak, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
        oscillator.stop(at + seconds + 0.01);
    }

    function playCycle() {
        if (!ctx) {
            return;
        }
        const now = ctx.currentTime;
        const step = (pulseMs + pulseGapMs) / 1000;
        for (let i = 0; i < pulseCount; i++) {
            schedulePulse(now + (i * step));
        }
    }

    function stop() {
        if (cycleTimer) {
            clearInterval(cycleTimer);
            cycleTimer = null;
        }
        try {
            if (ctx && ctx.state !== 'closed') {
                ctx.close();
            }
        } catch (e) {
            /* ignore */
        }
        ctx = null;
    }

    function start() {
        stop();
        try {
            const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextCtor) {
                return;
            }
            ctx = new AudioContextCtor();
            if (ctx.state === 'suspended' && ctx.resume) {
                ctx.resume().catch(() => {
                    /* no user gesture on this page yet */
                });
            }
            playCycle();
            cycleTimer = setInterval(playCycle, cycleMs);
        } catch (e) {
            /* Web Audio blocked */
        }
    }

    return {start, stop};
}

// Incoming: an urgent double beep, close together, repeating briskly.
const incomingRinger = createRinger({
    frequency: 800,
    pulseMs: 350,
    pulseCount: 2,
    pulseGapMs: 150,
    cycleMs: 1600,
    peak: 0.08,
});

// Outgoing: the familiar ringback — one long, low tone with a long gap, quieter
// than the incoming ring because it plays into the caller's own ear.
const outgoingRinger = createRinger({
    frequency: 425,
    pulseMs: 1000,
    pulseCount: 1,
    pulseGapMs: 0,
    cycleMs: 4000,
    peak: 0.04,
});

export function startIncomingRing() {
    incomingRinger.start();
}

export function stopIncomingRing() {
    incomingRinger.stop();
}

export function startOutgoingRingback() {
    outgoingRinger.start();
}

export function stopOutgoingRingback() {
    outgoingRinger.stop();
}
