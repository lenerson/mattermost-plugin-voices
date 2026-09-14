import VoiceSession, {VOICE_SESSION_ACTIVE, VOICE_SESSION_IDLE} from './voiceSession';

describe('VoiceSession', () => {
    test('owns media and connections for one active room', () => {
        const session = new VoiceSession();
        const stream = {getTracks: jest.fn(() => [])};
        const hub = {close: jest.fn()};
        const swarm = {close: jest.fn((done) => done())};

        expect(session.start('room-1')).toBe(true);
        expect(session.state).toBe(VOICE_SESSION_ACTIVE);
        expect(session.setStream('room-1', stream)).toBe(true);
        expect(session.setConnection('room-1', hub, swarm)).toBe(true);

        session.close();

        expect(stream.getTracks).toHaveBeenCalledTimes(1);
        expect(swarm.close).toHaveBeenCalledTimes(1);
        expect(hub.close).toHaveBeenCalledTimes(1);
        expect(session.state).toBe(VOICE_SESSION_IDLE);
    });

    test('rejects a second room and disposes stale resources', () => {
        const session = new VoiceSession();
        const staleTrack = {stop: jest.fn()};
        const staleStream = {getTracks: jest.fn(() => [staleTrack])};
        const staleHub = {close: jest.fn()};
        const staleSwarm = {close: jest.fn()};

        expect(session.start('room-1')).toBe(true);
        expect(session.start('room-2')).toBe(false);
        expect(session.setStream('room-2', staleStream)).toBe(false);
        expect(session.setConnection('room-2', staleHub, staleSwarm)).toBe(false);

        expect(staleTrack.stop).toHaveBeenCalledTimes(1);
        expect(staleHub.close).toHaveBeenCalledTimes(1);
        expect(staleSwarm.close).toHaveBeenCalledTimes(1);
    });

    test('continues cleanup after a swarm close failure and releases queued callers', () => {
        const timers = [];
        const session = new VoiceSession({
            closeTimeoutMs: 10,
            setTimeoutFn: (callback) => {
                timers.push(callback);
                return callback;
            },
            clearTimeoutFn: jest.fn(),
        });
        const first = jest.fn();
        const second = jest.fn();

        session.start('room-1');
        session.setConnection('room-1', {close: jest.fn()}, {close: () => { throw new Error('close failed'); }});
        session.close(first);
        session.close(second);

        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
        expect(session.state).toBe(VOICE_SESSION_IDLE);
        expect(timers).toHaveLength(1);
    });
});
