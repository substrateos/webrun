export default async function () {
    if (typeof globalThis.RTCPeerConnection === "undefined") {
        throw new Error("RTCPeerConnection not exposed globally");
    }

    const pc1 = new RTCPeerConnection({ iceServers: [] });
    const pc2 = new RTCPeerConnection({ iceServers: [] });

    pc1.onicecandidate = e => {
        if (e.candidate) {
            console.log("PC1 CANDIDATE:", e.candidate.candidate);
            pc2.addIceCandidate(e.candidate);
        }
    };
    pc2.onicecandidate = e => {
        if (e.candidate) {
            console.log("PC2 CANDIDATE:", e.candidate.candidate);
            pc1.addIceCandidate(e.candidate);
        }
    };

    const dc1 = pc1.createDataChannel("echo");

    const incomingData = new Promise(resolve => {
        pc2.ondatachannel = (e) => {
            const dc2 = e.channel;
            dc2.onmessage = (msg) => {
                resolve(msg.data);
                dc2.send("pong:" + msg.data);
            };
        };
    });

    const pongData = new Promise(resolve => {
        dc1.onmessage = e => resolve(e.data);
    });

    console.log("STEP 1: setup complete");
    const offer = await pc1.createOffer();
    console.log("STEP 2: offer created");
    await pc1.setLocalDescription(offer);
    console.log("STEP 3: offer set on pc1");
    await pc2.setRemoteDescription(offer);
    console.log("STEP 4: offer set on pc2");

    const answer = await pc2.createAnswer();
    console.log("STEP 5: answer created");
    await pc2.setLocalDescription(answer);
    console.log("STEP 6: answer set on pc2");
    await pc1.setRemoteDescription(answer);
    console.log("STEP 7: answer set on pc1");

    console.log("STEP 8: waiting for data channel to open...");
    await new Promise(r => {
        if (dc1.readyState === "open") r();
        else dc1.onopen = r;
    });

    console.log("STEP 9: sending ping...");
    dc1.send("ping");

    const r1 = await incomingData;
    const r2 = await pongData;

    if (r1 !== "ping" || r2 !== "pong:ping") {
        throw new Error("Data channel multiplexing payload failed: " + r1 + " / " + r2);
    }

    console.log("WEBRTC_P2P_LOOPBACK_SUCCESS");
}
