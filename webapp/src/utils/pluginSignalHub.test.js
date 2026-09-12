/* eslint-disable max-nested-callbacks */
import axios from 'axios';

jest.mock('manifest', () => ({id: 'plugin-id'}), {virtual: true});

import {authorizedSignalHub, authorizedSignalInbox, createAuthorizedSignalHub} from './pluginSignalHub';

jest.mock('axios');

describe('authorized signal hub', () => {
    let eventSource;

    beforeEach(() => {
        global.document = {cookie: 'MMCSRF=csrf-token'};
        eventSource = {
            close: jest.fn(),
        };
        global.EventSource = jest.fn(() => eventSource);
    });

    afterEach(() => {
        delete global.EventSource;
        delete global.document;
        jest.clearAllMocks();
    });

    test('subscribes through an authorized session instead of a client topic', () => {
        const hub = authorizedSignalHub({version: 1, sessionId: 'session-1', callId: 'call-1'});

        const stream = hub.subscribe('ignored-channel');

        expect(global.EventSource).toHaveBeenCalledWith(expect.stringContaining('sessionId=session-1'));
        expect(global.EventSource).not.toHaveBeenCalledWith(expect.stringContaining('ignored-channel'));

        stream.destroy();
        expect(eventSource.close).toHaveBeenCalled();
    });

    test('publishes a versioned envelope without a browser-controlled sender', async () => {
        axios.post.mockResolvedValue({});
        const hub = authorizedSignalHub({version: 1, sessionId: 'session-1', callId: 'call-1'});
        const done = jest.fn();

        hub.broadcast('ignored-channel', {candidate: 'candidate-data'}, done);
        await Promise.resolve();

        expect(axios.post).toHaveBeenCalledWith(
            expect.stringContaining('/v1/signal/publish'),
            {
                version: 1,
                sessionId: 'session-1',
                callId: 'call-1',
                type: 'webrtc',
                payload: {candidate: 'candidate-data'},
            },
            expect.objectContaining({withCredentials: true}),
        );
        expect(done).toHaveBeenCalledWith();
    });

    test('uses the server-authenticated sender when receiving a signal', async () => {
        const hub = authorizedSignalHub({version: 1, sessionId: 'session-1', callId: 'call-1'});
        const stream = hub.subscribe();
        const received = jest.fn();
        stream.on('data', received);

        eventSource.onmessage({data: JSON.stringify({
            version: 1,
            sessionId: 'session-1',
            callId: 'call-1',
            type: 'webrtc',
            senderId: 'authenticated-user',
            payload: {fromUserId: 'spoofed-user', candidate: 'candidate-data'},
        })});

        await new Promise(setImmediate);

        expect(received).toHaveBeenCalledWith({
            fromUserId: 'authenticated-user',
            candidate: 'candidate-data',
        });
    });

    test('creates a server-owned session before returning a hub', async () => {
        axios.post.mockResolvedValue({
            data: {version: 1, sessionId: 'session-1', callId: 'call-1'},
        });

        const hub = await createAuthorizedSignalHub('call-1', ['callee']);

        expect(hub.app).toBe('signal-session-session-1');
        expect(axios.post).toHaveBeenCalledWith(
            expect.stringContaining('/v1/signal/sessions'),
            {callId: 'call-1', participants: ['callee']},
            expect.objectContaining({withCredentials: true}),
        );
    });

    test('subscribes to the authenticated private inbox without a user topic', () => {
        const stream = authorizedSignalInbox();

        expect(global.EventSource).toHaveBeenCalledWith(expect.stringContaining('inbox=true'));
        expect(global.EventSource).not.toHaveBeenCalledWith(expect.stringContaining('user-'));

        stream.destroy();
        expect(eventSource.close).toHaveBeenCalled();
    });
});
