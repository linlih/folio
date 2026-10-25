/** One user action outside an editor, such as moving a card to the trash,
 *  undone and redone as a whole. Edits inside an editor use that document's
 *  own Loro undo; an edit there that also changed other documents tags its
 *  undo step instead (editor/stepTags.ts). */
export interface UndoGroup {
  label: string;
  undo(): Promise<void>;
  redo(): Promise<void>;
}

/** The app-level undo stack for actions taken outside editors (§5.1). */
export class AppUndo {
  private done: UndoGroup[] = [];
  private undone: UndoGroup[] = [];
  private busy = false;

  /** Records a group that has just been applied. */
  push(group: UndoGroup) {
    this.done.push(group);
    this.undone = [];
  }

  /** False when there is nothing to undo. */
  undo(): Promise<boolean> {
    return this.step(this.done, this.undone, (g) => g.undo());
  }

  redo(): Promise<boolean> {
    return this.step(this.undone, this.done, (g) => g.redo());
  }

  private async step(from: UndoGroup[], to: UndoGroup[], run: (g: UndoGroup) => Promise<void>) {
    const top = from.at(-1);
    if (!top || this.busy) return false;
    this.busy = true;
    try {
      await run(top);
    } finally {
      this.busy = false;
    }
    from.pop();
    to.push(top);
    return true;
  }
}
