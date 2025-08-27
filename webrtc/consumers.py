import json
from channels.generic.websocket import AsyncWebsocketConsumer

class SignalingConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        # Add this connection to a group so messages can be broadcast
        self.room_group_name = "webrtc_group"
        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name
        )
        await self.accept()
        print("WebSocket connected")

    async def disconnect(self, close_code):
        # Remove from the group on disconnect
        await self.channel_layer.group_discard(
            self.room_group_name,
            self.channel_name
        )
        print("WebSocket disconnected")

    async def receive(self, text_data):
        data = json.loads(text_data)
        # Broadcast the signaling data to all clients in the group
        await self.channel_layer.group_send(
            self.room_group_name,
            {
                "type": "signal.message",
                "message": data
            }
        )

    async def signal_message(self, event):
        # Send the message to the WebSocket
        message = event['message']
        await self.send(text_data=json.dumps(message))
