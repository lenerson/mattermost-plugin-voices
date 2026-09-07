import ActionTypes from '../action_types';

import reducer from './index';

function reduce(actions) {
    return actions.reduce((state, action) => reducer(state, action), {});
}

const INIT = {type: '@@INIT'};

// The modal renders "Connecting…" for exactly `callAccepted && !callPeerStream`.
const isStuckConnecting = (state) => state.callAccepted && !state.callPeerStream;

const inCall = [
    INIT,
    {type: ActionTypes.MAKE_VIDEO_CALL, data: {peerId: 'p1', callId: 'c1'}},
    {type: ActionTypes.PEER_ACCEPTED, data: {}},
    {type: ActionTypes.PEER_STREAM_RECEIVED, data: {id: 'remote-stream'}},
];

describe('call lifecycle', () => {
    test('a connected call is not showing the connecting state', () => {
        expect(isStuckConnecting(reduce(inCall))).toBe(false);
    });

    /*
     * Why the disconnect handler ends the call rather than only reporting the
     * lost peer: PEER_LOST clears the remote stream but leaves callAccepted
     * true, which is precisely the state the modal spins on.
     */
    test('PEER_LOST on its own drops the call into the connecting state', () => {
        const state = reduce([...inCall, {type: ActionTypes.PEER_LOST, data: {}}]);

        expect(state.callPeerStream).toBeNull();
        expect(state.callAccepted).toBe(true);
        expect(isStuckConnecting(state)).toBe(true);
    });

    test('ending the call after losing the peer closes the modal', () => {
        const state = reduce([
            ...inCall,
            {type: ActionTypes.PEER_LOST, data: {}},
            {type: ActionTypes.END_CALL, data: {}},
        ]);

        expect(isStuckConnecting(state)).toBe(false);
        expect(state.callAccepted).toBe(false);
        expect(state.modalVisible).toBe(false);
        expect(state.callOutgoing).toBe(false);
        expect(state.callIncoming).toBe(false);
    });

    test('ending a call clears the peer and self streams', () => {
        const state = reduce([
            ...inCall,
            {type: ActionTypes.SELF_STREAM_SET, data: {id: 'local-stream'}},
            {type: ActionTypes.END_CALL, data: {}},
        ]);

        expect(state.callPeerStream).toBeNull();
        expect(state.selfStream).toBeNull();
    });

    test('a media error is cleared when the next call starts', () => {
        const state = reduce([
            INIT,
            {type: ActionTypes.MEDIA_ERROR, data: 'camera busy'},
            {type: ActionTypes.MAKE_VIDEO_CALL, data: {peerId: 'p2', callId: 'c2'}},
        ]);

        expect(state.mediaError).toBe('');
    });
});
