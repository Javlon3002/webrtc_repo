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
const roomId = new URLSearchParams(location.search).get('room') || 'webrtc';
let ws = null;
let pc = null;
let localStream = null;
let isMuted = false;
let isCameraOff = false;
let role = null;
let otherId = null;
const pendingRemoteCandidates = [];

const wsScheme = (window.location.protocol === 'https:') ? 'wss' : 'ws';
const wsUrl = `${wsScheme}://${window.location.host}/ws/signaling/`;

function setStatus(msg) { statusEl.textContent = msg; }

// --- WebSocket setup ---
function connectWS() {
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    setStatus('websocket connected');
    // send a proper join with room + peer id
    send({ type: 'join' });
  };

  ws.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    if (data.from && data.from === myId) return; // ignore own messages that bounce back

    switch (data.type) {

      case 'room_full':
        setStatus('room full');
        break;

      case 'role':
        role = data.role; // 'caller' or 'callee'
        setStatus(`role: ${role}`);
        ensurePeerConnection();
        break;

      case 'peer_ready':
        otherId = data.other;
        setStatus(`peer: ${otherId} ready`);

        // Caller creates and sends the offer *only when peer is ready*
        if (role === 'caller') {
          const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
          await pc.setLocalDescription(offer);
          send({ type: 'offer', sdp: pc.localDescription });
          setStatus('offer sent');
        }
        break;

      case 'offer':
        otherId = data.from;
        ensurePeerConnection();
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: 'answer', sdp: pc.localDescription });
        await flushPendingCandidates();
        setStatus('answer sent');
        break;

      case 'answer':
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        await flushPendingCandidates();
        setStatus('answer received');
        break;

      case 'ice':
        if (!pc || !data.candidate) return;
        try {
          const cand = new RTCIceCandidate(data.candidate);
          if (pc.remoteDescription) {
            await pc.addIceCandidate(cand);
          } else {
            // buffer until remote description is set
            pendingRemoteCandidates.push(cand);
          }
        } catch (err) {
          console.error('Error adding ICE candidate', err);
        }
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
    // always attach addressing info
    const payload = { roomId, peerId: myId, ...obj };
    if (!payload.to && otherId) payload.to = otherId; // direct to the other peer if known
    ws.send(JSON.stringify(payload));
  }
}

// --- WebRTC setup ---
function ensurePeerConnection() {
  if (pc) return;

  pc = new RTCPeerConnection({
    iceServers: [
      // Keep your original STUN servers
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },

      // OPTIONAL: add your TURN later for reliability across NATs
      // { urls: 'turn:turn.umikt-communication.tech:3478', username: 'webrtcuser', credential: 'SECRET' },
      // { urls: 'turn:turn.umikt-communication.tech:3478?transport=tcp', username: 'webrtcuser', credential: 'SECRET' },
      // { urls: 'turns:turn.umikt-communication.tech:5349', username: 'webrtcuser', credential: 'SECRET' }
    ],
    // For best performance once TURN is set up, leave policy default ("all")
    // iceTransportPolicy: "all"
  });

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      send({ type: 'ice', candidate: e.candidate });
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

async function flushPendingCandidates() {
  while (pendingRemoteCandidates.length) {
    try { await pc.addIceCandidate(pendingRemoteCandidates.shift()); }
    catch (e) { console.warn('addIceCandidate (flush) failed', e); }
  }
}

async function join() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectWS();
    // tiny wait to ensure ws.onopen ran; in real apps use a proper "opened" promise
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

  // NOTE: we no longer create the offer here.
  // The offer is created only after we receive 'peer_ready' and if role === 'caller'.

  joinBtn.disabled = true;
  leaveBtn.disabled = false;
  muteBtn.disabled = false;
  cameraBtn.disabled = false;
  setStatus('joined (waiting for peer)');
}

function leave() {
  send({ type: 'leave' });
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
  role = null;
  otherId = null;
  pendingRemoteCandidates.length = 0;
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

// Connect WS early (safe), real media starts when you click Join
connectWS();
