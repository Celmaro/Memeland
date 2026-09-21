export type StateTransitions<S extends string> = Record<S, readonly S[]>;

/** Explicit transition-map state machine that rejects invalid edges. */
export class StateMachine<S extends string> {
  private currentState: S;

  constructor(
    initial: S,
    protected readonly transitions: StateTransitions<S>,
  ) {
    this.currentState = initial;
  }

  get state(): S {
    return this.currentState;
  }

  canTransitionTo(next: S): boolean {
    return this.transitions[this.currentState]?.includes(next) ?? false;
  }

  transitionTo(next: S): S {
    if (!this.canTransitionTo(next)) {
      throw new Error(`Invalid ${this.currentState} -> ${next} transition`);
    }
    this.currentState = next;
    return next;
  }
}

export const APPROVAL_ORDER_STATES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type ApprovalOrderState = (typeof APPROVAL_ORDER_STATES)[number];

export const approvalOrderTransitions: StateTransitions<ApprovalOrderState> = {
  PENDING: ['APPROVED', 'REJECTED'],
  APPROVED: [],
  REJECTED: [],
};

export class ApprovalOrderStateMachine extends StateMachine<ApprovalOrderState> {
  constructor(initialState: ApprovalOrderState = 'PENDING') {
    super(initialState, approvalOrderTransitions);
  }
}
