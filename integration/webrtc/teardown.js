export default async function () {
    // Sequentially create, bind, and teardown RTCPeerConnections.
    // If the host-side udp_relay or werift memory is leaking on close(),
    // This quickly exposes it by exceeding standard POSIX ulimit -n defaults (e.g. 256/1024).
    for (let i = 0; i < 1500; i++) {
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.createDataChannel("teardown_test");

        const bound = new Promise(resolve => {
            pc.onicecandidate = e => {
                if (e.candidate) resolve();
            };
        });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        // Wait for ICE gathering to emit at least one candidate,
        // which physically proves the udp_relay bound the socket on the host.
        await bound;
        
        pc.close();
    }
    console.log("TEARDOWN_OK");
}
