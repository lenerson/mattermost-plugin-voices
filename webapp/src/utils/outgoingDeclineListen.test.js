import {attachOutgoingDeclineListener, clearOutgoingDeclineListener} from './outgoingDeclineListen';

function fakeHub() {
    const stream = {handler: null, destroy: jest.fn(), on: (_event, handler) => { stream.handler = handler; }};
    return {stream, subscribe: jest.fn(() => stream)};
}

describe('outgoingDeclineListen', () => {
    afterEach(clearOutgoingDeclineListener);

    test('rejects a spoofed decline when the authenticated sender differs', () => {
        const hub = fakeHub();
        const onDecline = jest.fn();
        attachOutgoingDeclineListener(hub, 'caller', 'callee', onDecline);

        hub.stream.handler({fromUserId: 'attacker', calleeId: 'callee'});

        expect(onDecline).not.toHaveBeenCalled();
    });

    test('accepts a decline from the authenticated callee', () => {
        const hub = fakeHub();
        const onDecline = jest.fn();
        attachOutgoingDeclineListener(hub, 'caller', 'callee', onDecline);

        hub.stream.handler({fromUserId: 'callee', calleeId: 'attacker'});

        expect(onDecline).toHaveBeenCalledTimes(1);
    });
});
