import ActionTypes from '../action_types';

import reducer from './index';

// combineReducers hands each slice its own default when the key is absent, so
// an empty object is the initial state without naming undefined.
function reduce(actions) {
    return actions.reduce((state, action) => reducer(state, action), {});
}

const INIT = {type: '@@INIT'};

describe('audio-only calls', () => {
    test('a call defaults to video on', () => {
        const state = reduce([INIT]);

        expect(state.videoOn).toBe(true);
        expect(state.callAudioOnly).toBe(false);
    });

    test('placing a call from the phone button starts with the camera off', () => {
        const state = reduce([
            INIT,
            {type: ActionTypes.MAKE_VIDEO_CALL, data: {peerId: 'p1', callId: 'c1', audioOnly: true}},
        ]);

        expect(state.callAudioOnly).toBe(true);
        expect(state.videoOn).toBe(false);
    });

    test('placing a call from the camera button starts with video on', () => {
        const state = reduce([
            INIT,
            {type: ActionTypes.MAKE_VIDEO_CALL, data: {peerId: 'p1', callId: 'c1', audioOnly: false}},
        ]);

        expect(state.callAudioOnly).toBe(false);
        expect(state.videoOn).toBe(true);
    });

    // The mode travels with the ring: answering a voice call must not switch
    // the callee's camera on.
    test('receiving a voice call keeps the callee camera off', () => {
        const state = reduce([
            INIT,
            {type: ActionTypes.RECEIVE_VIDEO_CALL, data: {peerId: 'p1', callId: 'c1', audioOnly: true}},
        ]);

        expect(state.callAudioOnly).toBe(true);
        expect(state.videoOn).toBe(false);
    });

    test('receiving a video call turns the callee camera on', () => {
        const state = reduce([
            INIT,
            {type: ActionTypes.RECEIVE_VIDEO_CALL, data: {peerId: 'p1', callId: 'c1', audioOnly: false}},
        ]);

        expect(state.videoOn).toBe(true);
    });

    test('video can still be switched on during a voice call', () => {
        const state = reduce([
            INIT,
            {type: ActionTypes.MAKE_VIDEO_CALL, data: {peerId: 'p1', callId: 'c1', audioOnly: true}},
            {type: ActionTypes.VIDEO_TOGGLE, data: true},
        ]);

        expect(state.videoOn).toBe(true);
    });

    test.each([
        ['ending', ActionTypes.END_CALL],
        ['rejecting', ActionTypes.REJECT_CALL],
    ])('%s a call clears the audio-only mode', (_label, type) => {
        const state = reduce([
            INIT,
            {type: ActionTypes.MAKE_VIDEO_CALL, data: {peerId: 'p1', callId: 'c1', audioOnly: true}},
            {type, data: {}},
        ]);

        expect(state.callAudioOnly).toBe(false);
    });

    // A caller on an older build sends no flag at all.
    test('a ring with no audioOnly flag is treated as a video call', () => {
        const state = reduce([
            INIT,
            {type: ActionTypes.RECEIVE_VIDEO_CALL, data: {peerId: 'p1', callId: 'c1'}},
        ]);

        expect(state.callAudioOnly).toBe(false);
        expect(state.videoOn).toBe(true);
    });
});
