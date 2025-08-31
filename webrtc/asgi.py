import os
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack
from django.core.asgi import get_asgi_application
import webrtc.routing

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "webrtc.settings")

application = ProtocolTypeRouter({
    "http": get_asgi_application(),
    "websocket": AuthMiddlewareStack(
        URLRouter(webrtc.routing.websocket_urlpatterns)
    ),
})
