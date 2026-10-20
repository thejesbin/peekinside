/**
 * The requests an instance serves, for its process samples: how many are open, and how many
 * finished since the last sample. Two numbers, no request data.
 */
export class RequestCounter {
  constructor() {
    this.open = 0;
    this.finished = 0;
  }

  /**
   * A request started.
   *
   * @returns {void}
   */
  started() {
    this.open++;
  }

  /**
   * A request finished (or its connection closed first).
   *
   * @returns {void}
   */
  ended() {
    this.open = Math.max(0, this.open - 1);
    this.finished++;
  }

  /**
   * The requests finished since the last call, and the ones open now.
   *
   * @returns {{ finished: number, open: number }}
   */
  take() {
    const finished = this.finished;
    this.finished = 0;
    return { finished, open: this.open };
  }
}
