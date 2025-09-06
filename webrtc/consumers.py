# webrtc/consumers.py
import json
from channels.generic.websocket import AsyncJsonWebsocketConsumer

class SignalingConsumer(AsyncJsonWebsocketConsumer):
    """
    Scalable signaling via Channels groups (Redis). No per-process state.
    Clients send: {type, roomId, peerId, ...}
    Server:
      - on join: add to group, ack join, notify others 'peer_joined'
      - on leave: notify others 'peer_left'
      - relay offer/answer/candidate to room; clients filter by 'to'
    """

    async def connect(self):
        await self.accept()
        self.room_id = None
        self.group = None
        self.peer_id = None

    async def disconnect(self, close_code):
        if self.group:
            if self.peer_id:
                await self.channel_layer.group_send(
                    self.group,
                    {"type": "peer.left", "peerId": self.peer_id}
                )
            await self.channel_layer.group_discard(self.group, self.channel_name)

    async def receive_json(self, m):
        t = m.get("type")

        if t == "join":
            self.room_id = m.get("roomId", "webrtc")
            self.peer_id = m.get("peerId")
            self.group = f"room_{self.room_id}"

            await self.channel_layer.group_add(self.group, self.channel_name)

            # Ack to the joiner
            await self.send_json({"type": "join_ack", "roomId": self.room_id, "peerId": self.peer_id})

            # Notify others someone joined
            await self.channel_layer.group_send(
                self.group,
                {"type": "peer.joined", "peerId": self.peer_id}
            )
            return

        if t == "leave":
            if self.group and self.peer_id:
                await self.channel_layer.group_send(
                    self.group,
                    {"type": "peer.left", "peerId": self.peer_id}
                )
            return

        # For signaling messages, require a known peer and group
        if not self.group or not self.peer_id:
            return

        # Attach sender and fan out
        m["from"] = self.peer_id
        await self.channel_layer.group_send(
            self.group,
            {"type": "signal.message", "message": m}
        )

    # ----- Group event handlers -----

    async def peer_joined(self, event):
        # Deliver to everyone except the joiner
        if event["peerId"] != self.peer_id:
            await self.send_json({"type": "peer_joined", "peerId": event["peerId"]})

    async def peer_left(self, event):
        if event["peerId"] != self.peer_id:
            await self.send_json({"type": "peer_left", "peerId": event["peerId"]})

    async def signal_message(self, event):
        msg = event["message"]
        # Targeted delivery if 'to' is set
        to_id = msg.get("to")
        if to_id and to_id != self.peer_id:
            return
        # Avoid echoing back to sender
        if msg.get("from") == self.peer_id:
            return
        await self.send_json(msg)

