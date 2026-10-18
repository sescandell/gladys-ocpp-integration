/**
 * A command (or probe) towards a charge point that could not be carried out,
 * with the HTTP status that describes it to the main container (see
 * stateApi.ts): 400 bad request, 404 unknown command, 409 not connected,
 * 422 not supported by this charge point, 502 refused / no answer.
 */
export class CommandError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
