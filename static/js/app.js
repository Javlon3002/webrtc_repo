// --- DOM refs ---
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const muteBtn = document.getElementById('muteBtn');
const cameraBtn = document.getElementById('cameraBtn');
const statusEl = document.getElementById('status');

// --- state ---
const myId = Math.random().toString(36).slice(2, 10);
let ws = null;
let pc = null;
let localStream = null;
let isMuted = false;
let isCameraOff = false;

const wsScheme = (window.location.protocol === 'https:') ? 'wss' : 'ws';
const wsUrl = `${wsScheme}://${window.location.host}/ws/signaling/`;

function setStatus(msg) { statusEl.textContent = msg; }

// --- WebSocket setup ---
function connectWS() {
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    setStatus('websocket connected');
    ws.send(JSON.stringify({ type: 'join', from: myId }));
  };

  ws.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    if (data.from === myId) return; // ignore own messages

    switch (data.type) {
      case 'offer':
        ensurePeerConnection();
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: 'answer', sdp: pc.localDescription, from: myId });
        break;

      case 'answer':
        if (!pc) return;
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        break;

      case 'ice':
        if (!pc || !data.candidate) return;
        try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); }
        catch (err) { console.error('Error adding ICE candidate', err); }
        break;

      case 'leave':
        teardownPeer();
        break;
    }
  };

  ws.onclose = () => setStatus('websocket closed');
  ws.onerror = () => setStatus('websocket error');
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// --- WebRTC setup ---
function ensurePeerConnection() {
  if (pc) return;





pc = new RTCPeerConnection({
  iceServers: [
    // STUN (either your own or Google)
    { urls: 'stun:turn.umikt-communication.tech:3478' },
    { urls: 'stun:stun.l.google.com:19302' },

    // TURN over UDP
    {
      urls: 'turn:turn.umikt-communication.tech:3478',
      username: 'webrtcuser',
      credential: 'r7Jw3nYvT+Q5sA1dHgkKqQ=='
    },
    // TURN over TCP (fallback when UDP blocked)
    {
      urls: 'turn:turn.umikt-communication.tech:3478?transport=tcp',
      username: 'webrtcuser',
      credential: 'r7Jw3nYvT+Q5sA1dHgkKqQ=='
    },
    // TURN over TLS (for strict networks)
    {
      urls: 'turns:turn.umikt-communication.tech:5349',
      username: 'webrtcuser',
      credential: 'r7Jw3nYvT+Q5sA1dHgkKqQ=='
    }
  ],
  // This line forces the browser to only use TURN servers
  iceTransportPolicy: "relay"
});





 pc.onicecandidate = (e) => {
    if (e.candidate) {
      send({ type: 'ice', candidate: e.candidate, from: myId });
    }
  };

  pc.ontrack = (e) => {
    if (remoteVideo.srcObject !== e.streams[0]) {
      remoteVideo.srcObject = e.streams[0];
    }
  };

  if (localStream) {
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  }
}

async function join() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectWS();
    await new Promise((r) => setTimeout(r, 150));
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
  } catch (err) {
    alert('Could not access camera/mic: ' + err.message);
    return;
  }

  ensurePeerConnection();

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  send({ type: 'offer', sdp: pc.localDescription, from: myId });

  joinBtn.disabled = true;
  leaveBtn.disabled = false;
  muteBtn.disabled = false;
  cameraBtn.disabled = false;
  setStatus('joined (offer sent)');
}

function leave() {
  send({ type: 'leave', from: myId });
  teardownPeer(true);

  joinBtn.disabled = false;
  leaveBtn.disabled = true;
  muteBtn.disabled = true;
  cameraBtn.disabled = true;
  setStatus('left');
}

function teardownPeer(stopMedia = false) {
  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    try { pc.close(); } catch(_) {}
    pc = null;
  }
  if (stopMedia && localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  remoteVideo.srcObject = null;
  localVideo.srcObject = localStream || null;
}

function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  muteBtn.textContent = isMuted ? 'Unmute' : 'Mute';
}

function toggleCamera() {
  if (!localStream) return;
  isCameraOff = !isCameraOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isCameraOff);
  cameraBtn.textContent = isCameraOff ? 'Camera On' : 'Camera Off';
}

// --- wire buttons ---
joinBtn.addEventListener('click', join);
leaveBtn.addEventListener('click', leave);
muteBtn.addEventListener('click', toggleMute);
cameraBtn.addEventListener('click', toggleCamera);

connectWS(); // connect early
