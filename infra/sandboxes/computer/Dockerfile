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
    xfce4-terminal \
    zsh \
    zsh-autosuggestions \
    zsh-syntax-highlighting \
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
    libfile-mimeinfo-perl \
    pcmanfm \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 1000 rakazo \
  && useradd --uid 1000 --gid rakazo --create-home --shell /bin/zsh rakazo \
  && mkdir -p /etc/rakazo/fluxbox /etc/xdg/xfce4/terminal \
  && printf '%s\n' '#!/bin/sh' 'exec xsetroot -solid "#111113" "$@"' > /usr/bin/fbsetbg \
  && chmod +x /usr/bin/fbsetbg \
  && ln -sfn /bin/true /usr/bin/xmessage
# Developer tooling so a bot can clone, build, test and open pull requests. gh comes from GitHub's
# signed apt repository and serves as git's credential helper, so a GH_TOKEN in the shell
# environment authenticates both. Node is pinned and checked against its published SHA-256.
ARG NODE_VERSION=22.23.3
ARG NODE_SHA256_AMD64=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
ARG NODE_SHA256_ARM64=a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f
RUN set -eu \
  && arch="$(dpkg --print-architecture)" \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$arch signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends \
    git \
    gh \
    openssh-client \
    build-essential \
    pkg-config \
    python3-dev \
    python3-pip \
    python3-venv \
    ripgrep \
    fd-find \
    file \
    less \
    nano \
    unzip \
    zip \
    xz-utils \
  && rm -rf /var/lib/apt/lists/* \
  && ln -sfn /usr/bin/fdfind /usr/local/bin/fd \
  && case "$arch" in \
    amd64) node_arch=x64; node_sha="$NODE_SHA256_AMD64" ;; \
    arm64) node_arch=arm64; node_sha="$NODE_SHA256_ARM64" ;; \
    *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
  esac \
  && node_tar="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
  && curl -fsSLo "/tmp/$node_tar" "https://nodejs.org/dist/v${NODE_VERSION}/$node_tar" \
  && echo "$node_sha  /tmp/$node_tar" | sha256sum -c - \
  && tar -xJf "/tmp/$node_tar" -C /usr/local --strip-components=1 --no-same-owner \
    --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md --exclude='share/doc' \
  && rm "/tmp/$node_tar" \
  && corepack enable \
  && git config --system credential.https://github.com.helper '!/usr/bin/gh auth git-credential' \
  && git config --system init.defaultBranch main \
  && node --version && npm --version && git --version && gh --version
ENV DISPLAY=:1
ENV HOME=/home/rakazo
# LibreOffice profile outside the workspace so it never lands in checkpoints.
ENV UserInstallation=file:///tmp/libreoffice-profile
WORKDIR /home/rakazo
# --chmod normalizes modes: a restrictive host umask (e.g. 077 on hardened hosts) would
# otherwise leave these files unreadable to USER 1000 at runtime.
COPY --chmod=755 start.sh /usr/local/bin/rakazo-computer
COPY --chmod=755 control.py /usr/local/bin/rakazo-computer-control
COPY --from=capture-builder /build/librakazo-xcapture.so /usr/local/lib/librakazo-xcapture.so
COPY --chmod=755 rakazo-browser /usr/local/bin/rakazo-browser
COPY --chmod=755 rakazo-page-browser /usr/local/bin/rakazo-page-browser
COPY --chmod=755 rakazo-terminal /usr/local/bin/rakazo-terminal
COPY --chmod=644 terminalrc /etc/xdg/xfce4/terminal/terminalrc
COPY --chmod=644 zshrc /etc/rakazo/zshrc
COPY --chmod=644 rakazo-browser.desktop /usr/share/applications/rakazo-browser.desktop
COPY --chmod=644 fluxbox.init /etc/rakazo/fluxbox/init
COPY --chmod=644 fluxbox.apps /etc/rakazo/fluxbox/apps
COPY --chmod=644 fluxbox.menu /etc/rakazo/fluxbox/menu
COPY --chmod=644 libreoffice.xcd /usr/lib/libreoffice/share/registry/rakazo.xcd
COPY --chmod=644 embed.html /usr/share/novnc/embed.html
COPY --chmod=644 clipboard-bridge.js /usr/share/novnc/clipboard-bridge.js
COPY --chmod=644 mobile-keyboard.js /usr/share/novnc/mobile-keyboard.js
# Strip CR so shebangs work even if the build context came from a CRLF checkout.
RUN ldconfig \
  && sed -i 's/\r$//' /usr/local/bin/rakazo-computer /usr/local/bin/rakazo-computer-control /usr/local/bin/rakazo-browser /usr/local/bin/rakazo-page-browser \
    /usr/local/bin/rakazo-terminal /etc/rakazo/zshrc /etc/xdg/xfce4/terminal/terminalrc \
    /etc/rakazo/fluxbox/init /etc/rakazo/fluxbox/apps /etc/rakazo/fluxbox/menu
EXPOSE 7070 6080 6081 6082 6083 6084 6085 6086 6087 6088 6089 6090 6091 6092 6093 6094 6095
USER 1000:1000
CMD ["/usr/local/bin/rakazo-computer"]
