import CallSession, {CallSessionState} from './callSession';

describe('CallSession', () => {
    test('moves one call through ringing, connecting, connected, and idle', () => {
        const session = new CallSession();

        expect(session.start('call-1', 'peer-1')).toBe(true);
        expect(session.state).toBe(CallSessionState.RINGING);
        expect(session.beginConnecting('call-1')).toBe(true);
        expect(session.markConnected('call-1')).toBe(true);
        expect(session.state).toBe(CallSessionState.CONNECTED);
        expect(session.end('call-1')).toBe(true);
        expect(session.state).toBe(CallSessionState.IDLE);
        expect(session.callId).toBeNull();
    });

    test('rejects a second active call and events from another call id', () => {
        const session = new CallSession();
        session.start('call-1', 'peer-1');

        expect(session.start('call-2', 'peer-2')).toBe(false);
        expect(session.beginConnecting('call-2')).toBe(false);
        expect(session.markConnected('call-2')).toBe(false);
        expect(session.end('call-2')).toBe(false);
        expect(session.state).toBe(CallSessionState.RINGING);
        expect(session.callId).toBe('call-1');
    });

    test('releases owned resources when a call ends despite close failures', () => {
        const session = new CallSession();
        const cancel = jest.fn(() => {
            throw new Error('watch close failed');
        });
        const swarm = {close: jest.fn(() => {
            throw new Error('swarm close failed');
        })};
        const hub = {close: jest.fn()};
        const track = {stop: jest.fn()};
        const stream = {getTracks: () => [track]};
        session.start('call-1', 'peer-1');
        session.trackHub(hub);
        session.trackSwarm(swarm, cancel);
        session.setStream(stream);
        session.setPeer({send: jest.fn()});

        expect(session.end('call-1')).toBe(true);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(swarm.close).toHaveBeenCalledTimes(1);
        expect(hub.close).toHaveBeenCalledTimes(1);
        expect(track.stop).toHaveBeenCalledTimes(1);
        expect(session.state).toBe(CallSessionState.IDLE);
        expect(session.stream).toBeNull();
        expect(session.peer).toBeNull();
    });

    test('does not transition directly from ringing to connected', () => {
        const session = new CallSession();
        session.start('call-1', 'peer-1');

        expect(session.markConnected('call-1')).toBe(false);
        expect(session.fail('call-1')).toBe(true);
        expect(session.state).toBe(CallSessionState.FAILED);
    });

    test('rejects a peer event that arrives after the call has ended', () => {
        const session = new CallSession();
        session.start('call-1', 'peer-1');
        session.beginConnecting('call-1');
        session.end('call-1');

        expect(session.markConnected('call-1')).toBe(false);
        expect(session.state).toBe(CallSessionState.IDLE);
    });
});
