# webrtc/urls.py
from django.contrib import admin
from django.urls import path
from django.shortcuts import render
from django.contrib.staticfiles.urls import staticfiles_urlpatterns  # <-- add this

def index(request):
    return render(request, "index.html")

urlpatterns = [
    path("admin/", admin.site.urls),
    path("", index),
]

# Serve /static/* in DEBUG with any server (e.g., Daphne)
urlpatterns += staticfiles_urlpatterns()  # <-- add this line
