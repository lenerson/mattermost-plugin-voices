import {attachIncomingCancelListener, clearIncomingCancelListener} from './incomingCancelListen';

function fakeHub() {
    const stream = {
        handler: null,
        destroy: jest.fn(),
        on: (event, handler) => {
            if (event === 'data') {
                stream.handler = handler;
            }
        },
    };
    return {
        stream,
        subscribe: jest.fn(() => stream),
    };
}

describe('incomingCancelListen', () => {
    afterEach(() => {
        clearIncomingCancelListener();
    });

    test('subscribes to the callee own cancel channel', () => {
        const hub = fakeHub();

        attachIncomingCancelListener(hub, 'callee-id', 'caller-id', 'c1', jest.fn());

        expect(hub.subscribe).toHaveBeenCalledWith('cancel-callee-id');
    });

    test('fires when the caller we are ringing for cancels', () => {
        const hub = fakeHub();
        const onCancel = jest.fn();

        attachIncomingCancelListener(hub, 'callee-id', 'caller-id', 'c1', onCancel);
        hub.stream.handler({callerId: 'caller-id', callId: 'c1'});

        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    // Topics are shared by everyone on the server, so a cancel meant for another
    // conversation must not close this one.
    test('ignores a cancel from a different caller', () => {
        const hub = fakeHub();
        const onCancel = jest.fn();

        attachIncomingCancelListener(hub, 'callee-id', 'caller-id', 'c1', onCancel);
        hub.stream.handler({callerId: 'someone-else', callId: 'c1'});

        expect(onCancel).not.toHaveBeenCalled();
    });

    test('ignores a stale cancel from another call', () => {
        const hub = fakeHub();
        const onCancel = jest.fn();

        attachIncomingCancelListener(hub, 'callee-id', 'caller-id', 'current-call', onCancel);
        hub.stream.handler({callerId: 'caller-id', callId: 'previous-call'});

        expect(onCancel).not.toHaveBeenCalled();
    });

    test('accepts a JSON string payload', () => {
        const hub = fakeHub();
        const onCancel = jest.fn();

        attachIncomingCancelListener(hub, 'callee-id', 'caller-id', 'c1', onCancel);
        hub.stream.handler(JSON.stringify({callerId: 'caller-id', callId: 'c1'}));

        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['malformed json', '{not json'],
        ['null', null],
        ['no callerId', {callId: 'c1'}],
    ])('survives a %s payload', (_label, payload) => {
        const hub = fakeHub();
        const onCancel = jest.fn();

        attachIncomingCancelListener(hub, 'callee-id', 'caller-id', 'c1', onCancel);

        // A throw here fails the test on its own, which is the point.
        hub.stream.handler(payload);

        expect(onCancel).not.toHaveBeenCalled();
    });

    test('attaching again tears down the previous subscription', () => {
        const first = fakeHub();
        const second = fakeHub();

        attachIncomingCancelListener(first, 'callee-id', 'caller-id', 'c1', jest.fn());
        attachIncomingCancelListener(second, 'callee-id', 'other-caller', 'c2', jest.fn());

        expect(first.stream.destroy).toHaveBeenCalledTimes(1);
        expect(second.stream.destroy).not.toHaveBeenCalled();
    });

    test('clearing destroys the stream and is safe to repeat', () => {
        const hub = fakeHub();

        attachIncomingCancelListener(hub, 'callee-id', 'caller-id', 'c1', jest.fn());
        clearIncomingCancelListener();
        clearIncomingCancelListener();

        expect(hub.stream.destroy).toHaveBeenCalledTimes(1);
    });
});
