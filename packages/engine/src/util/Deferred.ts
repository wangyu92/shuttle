// A promise with its resolve/reject handles exposed (design §3.1 util/Deferred.ts).

export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (v: T) => void;
  reject!: (e: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }
}
