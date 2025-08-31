# webrtc/consumers.py
import json
from collections import defaultdict, deque
from channels.generic.websocket import AsyncWebsocketConsumer

# Room state in-memory (fine for local dev / single worker)
# roomId -> {"peers": {peerId: channel_name}, "order": [peerIds join order], "queues": {peerId: deque}}
rooms = {}

def get_room(room_id):
    if room_id not in rooms:
        rooms[room_id] = {"peers": {}, "order": [], "queues": defaultdict(deque)}
    return rooms[room_id]

class SignalingConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        await self.accept()
        self.room_id = None
        self.peer_id = None

    async def disconnect(self, close_code):
        if self.room_id and self.peer_id:
            room = rooms.get(self.room_id)
            if room:
                room["peers"].pop(self.peer_id, None)
                room["queues"].pop(self.peer_id, None)
                if not room["peers"]:
                    rooms.pop(self.room_id, None)

    async def receive(self, text_data):
        m = json.loads(text_data)
        t = m.get("type")

        if t == "join":
            self.room_id = m.get("roomId", "webrtc")  # default room id
            self.peer_id = m["peerId"]
            room = get_room(self.room_id)

            # Only 2 peers per room
            if len(room["peers"]) >= 2 and self.peer_id not in room["peers"]:
                await self.send_json({"type": "room_full"})
                await self.close()
                return

            # Register peer
            room["peers"][self.peer_id] = self.channel_name
            if self.peer_id not in room["order"]:
                room["order"].append(self.peer_id)

            # Role: first = caller, second = callee
            role = "caller" if len(room["order"]) == 1 else "callee"
            await self.send_json({"type": "role", "role": role})

            # When both are in, notify each side who the other is
            if len(room["peers"]) == 2:
                a, b = room["order"][0], room["order"][1]
                await self._send_to_peer(room, a, {"type": "peer_ready", "other": b})
                await self._send_to_peer(room, b, {"type": "peer_ready", "other": a})

            # Flush any queued messages for this peer
            q = room["queues"].get(self.peer_id)
            while q and q:
                await self.send_json(q.popleft())
            return

        # Ignore messages until joined
        if not self.room_id or not self.peer_id:
            return

        room = get_room(self.room_id)

        # Route to explicit recipient if provided; otherwise to "the other peer"
        to_id = m.get("to")
        if not to_id:
            others = [pid for pid in room["peers"].keys() if pid != self.peer_id]
            to_id = others[0] if others else None
        if not to_id:
            return

        m["from"] = self.peer_id
        await self._relay_or_queue(room, to_id, m)

    async def _send_to_peer(self, room, peer_id, msg):
        ch = room["peers"].get(peer_id)
        if ch:
            await self.channel_layer.send(ch, {"type": "signal.message", "message": msg})
        else:
            room["queues"][peer_id].append(msg)

    async def _relay_or_queue(self, room, to_id, msg):
        if to_id in room["peers"]:
            await self._send_to_peer(room, to_id, msg)
        else:
            room["queues"][to_id].append(msg)

    async def signal_message(self, event):
        await self.send(text_data=json.dumps(event["message"]))
