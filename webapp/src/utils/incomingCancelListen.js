let cancelSubStream;

/**
 * Listen for the caller giving up before we answered (caller broadcasts
 * cancel-${calleeId} on the shared signalling hub).
 *
 * Mirror image of outgoingDeclineListen: a call that is still ringing has no
 * peer connection yet, so there is nothing for the callee to notice dropping —
 * without this signal the incoming-call modal rings on for ever.
 */
export function attachIncomingCancelListener(hub, calleeId, callerId, callId, onCancel) {
    clearIncomingCancelListener();
    const stream = hub.subscribe(`cancel-${calleeId}`);
    cancelSubStream = stream;
    const handler = (payload) => {
        let data = payload;
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            } catch (e) {
                return;
            }
        }
        if (data && data.callerId === callerId && (!callId || data.callId === callId)) {
            onCancel();
        }
    };
    stream.on('data', handler);
}

export function clearIncomingCancelListener() {
    if (cancelSubStream) {
        try {
            cancelSubStream.destroy();
        } catch (e) {
            /* ignore */
        }
        cancelSubStream = null;
    }
}
