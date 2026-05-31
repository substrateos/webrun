export default async function () {
    const pc1 = new RTCPeerConnection({ iceServers: [] });
    const pc2 = new RTCPeerConnection({ iceServers: [] });

    pc1.onicecandidate = e => {
        if (e.candidate) pc2.addIceCandidate(e.candidate);
    };
    pc2.onicecandidate = e => {
        if (e.candidate) pc1.addIceCandidate(e.candidate);
    };

    const dc1 = pc1.createDataChannel("throughput");
    // WebRTC DataChannels typically fragment above ~16KB. Testing 64KB ensures fragmentation and reassembly works.
    const PAYLOAD_SIZE = 64 * 1024;
    const txPayload = new Uint8Array(PAYLOAD_SIZE);
    for (let i = 0; i < PAYLOAD_SIZE; i++) {
        txPayload[i] = i % 256;
    }

    const incomingData = new Promise(resolve => {
        pc2.ondatachannel = (e) => {
            const dc2 = e.channel;
            dc2.onmessage = (msg) => {
                let view;
                if (msg.data instanceof ArrayBuffer) {
                    view = new Uint8Array(msg.data);
                } else if (msg.data.buffer instanceof ArrayBuffer) {
                    view = new Uint8Array(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength);
                } else if (msg.data instanceof Blob) {
                    throw new Error("Received Blob but expected ArrayBuffer/View");
                }

                if (view && view.length === PAYLOAD_SIZE) {
                    let valid = true;
                    for (let i = 0; i < PAYLOAD_SIZE; i++) {
                        if (view[i] !== i % 256) valid = false;
                    }
                    if (valid) {
                        dc2.send("success");
                        resolve();
                    }
                }
            };
        };
    });

    const successData = new Promise(resolve => {
        dc1.onmessage = e => {
            if (e.data === "success") resolve();
        };
    });

    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);

    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);

    await new Promise(r => {
        if (dc1.readyState === "open") r();
        else dc1.onopen = r;
    });

    dc1.send(txPayload);
    await Promise.all([incomingData, successData]);
    console.log("THROUGHPUT_OK");
}
