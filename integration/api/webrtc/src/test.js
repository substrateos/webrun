export default function() {
    if (typeof RTCPeerConnection !== 'undefined') {
        try {
            const pc = new RTCPeerConnection();
            pc.close();
            console.log("WEBRTC_OK");
        } catch (e) {
            console.log("Error: " + e.message);
            throw e;
        }
    } else {
        console.log("RTCPeerConnection is missing");
        throw new Error("Missing");
    }
}
