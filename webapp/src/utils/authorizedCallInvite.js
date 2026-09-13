export async function deliverAuthorizedCallInvite({callId, peerId, audioOnly, createHub, sendInvite, legacyHub, legacyMessage}) {
    let hub;
    try {
        hub = await createHub(callId, [peerId]);
        await sendInvite(hub.session, peerId, {audioOnly});
        return hub;
    } catch (error) {
        if (hub) {
            hub.close();
        }
        legacyHub.broadcast(legacyMessage.channel, legacyMessage.payload);
        return null;
    }
}
