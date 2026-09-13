export async function deliverAuthorizedCallInvite({callId, peerId, audioOnly, createHub, sendInvite, onHub}) {
    let hub;
    try {
        hub = await createHub(callId, [peerId]);
        if (onHub) {
            await onHub(hub);
        }
        await sendInvite(hub.session, peerId, {audioOnly});
        return hub;
    } catch (error) {
        if (hub) {
            hub.close();
        }
        throw error;
    }
}
