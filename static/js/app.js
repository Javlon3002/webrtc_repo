// --- DOM refs ---
const localVideo  = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const joinBtn     = document.getElementById('joinBtn');
const leaveBtn    = document.getElementById('leaveBtn');
const muteBtn     = document.getElementById('muteBtn');
const cameraBtn   = document.getElementById('cameraBtn');
const statusEl    = document.getElementById('status');

// --- state ---
const myId   = Math.random().toString(36).slice(2, 10);
const roomId = new URLSearchParams(location.search).get('room') || 'webrtc';
let ws = null;
let pc = null;
let localStream = null;
let isMuted = false;
let isCameraOff = false;
let otherId = null;
let joined = false; // <-- new
const pendingRemoteCandidates = [];

const wsScheme = (window.location.protocol === 'https:') ? 'wss' : 'ws';
const wsUrl    = `${wsScheme}://${window.location.host}/ws/signaling/`;

function setStatus(msg) { if (statusEl) statusEl.textContent = msg; console.log(msg); }

// --- WebSocket setup ---
function connectWS() {
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    setStatus('websocket connected');
    // DO NOT auto-join here anymore
  };

  ws.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    if (data.from && data.from === myId) return;

    switch (data.type) {
      case 'join_ack':
        setStatus(`joined room ${roomId} as ${myId}`);
        break;

      case 'peer_joined':
        if (!joined) { setStatus(`peer ${data.peerId} joined (press Join)`); break; }
        if (data.peerId && data.peerId !== myId) {
          otherId = data.peerId;
          setStatus(`peer ${otherId} joined → creating offer`);
          await createOffer();
        }
        break;

      case 'peer_left':
        setStatus(`peer ${data.peerId} left`);
        teardownPeer();
        break;

      case 'offer': {
        if (!joined) { setStatus('offer received (press Join to answer)'); break; }
        otherId = data.from;
        ensurePeerConnection();
        await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        await flushPendingCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: 'answer', sdp: answer.sdp, to: otherId });
        setStatus('answer sent');
        break;
      }

      case 'answer':
        if (pc && pc.signalingState !== 'stable') {
          await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
          await flushPendingCandidates();
          setStatus('answer received');
        }
        break;

      case 'candidate':
        if (!pc || !data.candidate) return;
        try {
          const cand = new RTCIceCandidate(data.candidate);
          if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(cand);
          } else {
            pendingRemoteCandidates.push(cand);
          }
        } catch (err) {
          console.error('Error adding ICE candidate', err);
        }
        break;
    }
  };

  ws.onclose = () => { setStatus('websocket closed'); teardownPeer(); };
  ws.onerror = (e) => { console.error('websocket error', e); setStatus('websocket error'); };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const payload = { roomId, peerId: myId, ...obj };
    if (!payload.to && otherId) payload.to = otherId;
    ws.send(JSON.stringify(payload));
  }
}

// --- WebRTC setup ---
function ensurePeerConnection() {
  if (pc) return;

  // ===== KEEP THIS BLOCK EXACTLY AS REQUESTED =====
  pc = new RTCPeerConnection({
    iceServers: [
      // --- Google STUN fallback (keep these if you want) ---
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },

      // --- Your TURN server ---
      {
        urls: [
          'turn:umikt-communication.tech:3478?transport=udp',
          'turn:umikt-communication.tech:3478?transport=tcp',
          'turns:umikt-communication.tech:5349?transport=tcp'
        ],
        username: 'webrtcuser',
        credential: 'SuperSecret123'
      }
    ],

    // For debugging: allow all candidate types (host, srflx, relay)
    iceTransportPolicy: 'all'
  });

  // --- Debug logs for ICE/signaling states ---
  pc.onicegatheringstatechange = () => console.log('gathering:', pc.iceGatheringState);
  pc.oniceconnectionstatechange = () => console.log('ice:', pc.iceConnectionState);
  pc.onconnectionstatechange = () => console.log('pc:', pc.connectionState);
  pc.onsignalingstatechange = () => console.log('sig:', pc.signalingState);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      send({ type: 'candidate', candidate: e.candidate });
    }
  };

  pc.ontrack = (e) => {
    if (remoteVideo.srcObject !== e.streams[0]) {
      remoteVideo.srcObject = e.streams[0];
      setStatus('remote stream set');
      remoteVideo.play().catch(err => console.warn('remote play blocked:', err));
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

async function createOffer() {
  ensurePeerConnection();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: 'offer', sdp: offer.sdp, to: otherId });
  setStatus('offer sent');
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

  joined = true;                 // <-- mark joined
  send({ type: 'join' });        // <-- send join ONLY now
  ensurePeerConnection();        // add local tracks to pc

  joinBtn.disabled = true;
  leaveBtn.disabled = false;
  muteBtn.disabled = false;
  cameraBtn.disabled = false;
  setStatus('joined (waiting for peer)…');
}

function leave() {
  send({ type: 'leave' });
  teardownPeer(true);
  joined = false;

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

// Do NOT auto-join; only open WS
connectWS();
