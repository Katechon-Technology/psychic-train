FROM psychic-train/stream-client-base:latest

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl jq unzip \
        openjdk-21-jre-headless \
        libgl1 libglx-mesa0 libgl1-mesa-dri mesa-utils \
        libopenal1 libxi6 libxxf86vm1 libxrandr2 libxcursor1 libxinerama1 \
        libglfw3 libxtst6 \
    && rm -rf /var/lib/apt/lists/*

ARG MC_VERSION=1.21.11
ENV MC_VERSION=${MC_VERSION}

COPY download_mc.sh /app/download_mc.sh
COPY launch.sh /app/launch.sh
RUN chmod +x /app/download_mc.sh /app/launch.sh

# Pre-download vanilla client + all libraries into /opt/mc-data at build time.
# Bakes ~500MB into the image so first-session startup is instant.
RUN /app/download_mc.sh

# Software-OpenGL rendering (no GPU in the container).
ENV LIBGL_ALWAYS_SOFTWARE=1 \
    MESA_GL_VERSION_OVERRIDE=4.3 \
    MESA_GLSL_VERSION_OVERRIDE=430 \
    GALLIUM_DRIVER=llvmpipe \
    _JAVA_OPTIONS="-Dorg.lwjgl.opengl.libname=libGL.so.1"
