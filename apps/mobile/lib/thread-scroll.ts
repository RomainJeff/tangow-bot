export type ThreadScrollAction = "jump" | "smooth" | null;

export type ThreadScrollState = {
  detached: boolean;
  unread: boolean;
};

export class ThreadScrollBehavior {
  private threadKey: string | null = null;
  private laidOut = false;
  private contentReady = false;
  private latestMessageId: string | null = null;
  private currentState: ThreadScrollState = { detached: false, unread: false };

  openThread(threadKey: string): void {
    if (this.threadKey === threadKey) return;
    this.threadKey = threadKey;
    this.laidOut = false;
    this.contentReady = false;
    this.latestMessageId = null;
    this.currentState = { detached: false, unread: false };
  }

  onLayout(): ThreadScrollAction {
    this.laidOut = true;
    return this.contentReady && !this.currentState.detached ? "jump" : null;
  }

  onContentChanged(blocked: boolean, latestMessageId: string | null): ThreadScrollAction {
    if (blocked) return null;
    this.contentReady = true;
    if (latestMessageId === null || latestMessageId === this.latestMessageId) return null;
    const initial = this.latestMessageId === null;
    this.latestMessageId = latestMessageId;
    if (initial) return this.laidOut ? "jump" : null;
    if (this.currentState.detached) {
      this.setState(true, true);
      return null;
    }
    return "smooth";
  }

  /**
   * The bottom of the thread grew without a new message: the typing bubble
   * appeared or changed size. Follow it only when the reader sits at the
   * latest messages, so it never hides behind the composer.
   */
  onTailChanged(): ThreadScrollAction {
    if (!this.laidOut || !this.contentReady || this.currentState.detached) return null;
    return "smooth";
  }

  onUserScroll(distanceFromEnd: number): ThreadScrollState {
    const detached = distanceFromEnd > 80;
    this.setState(detached, detached && this.currentState.unread);
    return this.state();
  }

  jumpToLatest(): ThreadScrollAction {
    this.setState(false, false);
    return "smooth";
  }

  /** The same object until a value changes, so a scroll event that moves
   * nothing does not re-render the thread. */
  state(): ThreadScrollState {
    return this.currentState;
  }

  private setState(detached: boolean, unread: boolean): void {
    if (this.currentState.detached === detached && this.currentState.unread === unread) return;
    this.currentState = { detached, unread };
  }
}
