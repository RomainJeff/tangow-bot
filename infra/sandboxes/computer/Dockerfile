FROM debian:bookworm-slim AS capture-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libx11-dev \
    libxdamage-dev \
    libxext-dev \
    libxfixes-dev \
    libxtst-dev \
    libpng-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY xcapture.c .
RUN cc -O3 -fPIC -shared -Wall -Wextra -Werror -o librakazo-xcapture.so xcapture.c \
    -lX11 -lXext -lXdamage -lXfixes -lXtst -lpng

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    fluxbox \
    xterm \
    xdotool \
    x11-utils \
    x11-xserver-utils \
    imagemagick \
    novnc \
    websockify \
    python3 \
    ca-certificates \
    curl \
    jq \
    poppler-utils \
    procps \
    bash \
    chromium \
    fonts-liberation \
    fonts-dejavu-core \
    dbus-x11 \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 1000 rakazo \
  && useradd --uid 1000 --gid rakazo --create-home --shell /bin/bash rakazo \
  && mkdir -p /etc/rakazo/fluxbox \
  && printf '%s\n' '#!/bin/sh' 'exec xsetroot -solid "#111113" "$@"' > /usr/bin/fbsetbg \
  && chmod +x /usr/bin/fbsetbg \
  && ln -sfn /bin/true /usr/bin/xmessage
# --- horahow: office toolchain (same mechanics as the coding-harness document skills) ---
# LibreOffice headless for conversion/rendering (docx/xlsx/pptx -> pdf, pdf -> images via
# poppler), pandoc for markdown <-> docx, Python libs for structured generation, Node libs
# (docx, pptxgenjs) for the JS-based generators, metric-compatible fonts for Office fidelity.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    libreoffice-draw \
    pandoc \
    python3-pip \
    python3-venv \
    unzip \
    zip \
    nodejs \
    npm \
    fonts-crosextra-carlito \
    fonts-crosextra-caladea \
    fonts-noto-core \
  && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages \
    python-docx python-pptx openpyxl xlsxwriter reportlab pypdf pdfplumber pymupdf \
    markdown Pillow xxhash \
  && npm install -g --no-audit --no-fund docx pptxgenjs \
  && npm cache clean --force \
  && install -d -m 755 /usr/local/share/rakazo
ENV NODE_PATH=/usr/local/lib/node_modules
# The directory is created above with an explicit mode: COPY would otherwise inherit a
# restrictive host umask and leave it unreadable to USER 1000 (see comment further up).
COPY --chmod=644 OFFICE-TOOLS.md /usr/local/share/rakazo/OFFICE-TOOLS.md
# --- end horahow office toolchain ---
ENV DISPLAY=:1
ENV HOME=/home/rakazo
RUN npm install --global --no-audit --no-fund --cache /tmp/rakazo-npm-cache \
    @openai/codex@0.154.0 \
    @anthropic-ai/claude-code@2.1.282 \
  && npm cache clean --force \
  && rm -rf /tmp/rakazo-npm-cache
WORKDIR /home/rakazo
# --chmod normalizes modes: a restrictive host umask (e.g. 077 on hardened hosts) would
# otherwise leave these files unreadable to USER 1000 at runtime.
COPY --chmod=755 start.sh /usr/local/bin/rakazo-computer
COPY --chmod=755 control.py /usr/local/bin/rakazo-computer-control
COPY --from=capture-builder /build/librakazo-xcapture.so /usr/local/lib/librakazo-xcapture.so
COPY --chmod=755 rakazo-browser /usr/local/bin/rakazo-browser
COPY --chmod=755 rakazo-page-browser /usr/local/bin/rakazo-page-browser
COPY --chmod=644 rakazo-browser.desktop /usr/share/applications/rakazo-browser.desktop
COPY --chmod=644 fluxbox.init /etc/rakazo/fluxbox/init
COPY --chmod=644 fluxbox.apps /etc/rakazo/fluxbox/apps
COPY --chmod=644 fluxbox.menu /etc/rakazo/fluxbox/menu
COPY --chmod=644 embed.html /usr/share/novnc/embed.html
COPY --chmod=644 clipboard-bridge.js /usr/share/novnc/clipboard-bridge.js
COPY --chmod=644 mobile-keyboard.js /usr/share/novnc/mobile-keyboard.js
# Strip CR so shebangs work even if the build context came from a CRLF checkout.
RUN ldconfig \
  && sed -i 's/\r$//' /usr/local/bin/rakazo-computer /usr/local/bin/rakazo-computer-control /usr/local/bin/rakazo-browser /usr/local/bin/rakazo-page-browser \
    /etc/rakazo/fluxbox/init /etc/rakazo/fluxbox/apps /etc/rakazo/fluxbox/menu
EXPOSE 7070 6080 6081 6082 6083 6084 6085 6086 6087 6088 6089 6090 6091 6092 6093 6094 6095
USER 1000:1000
CMD ["/usr/local/bin/rakazo-computer"]
