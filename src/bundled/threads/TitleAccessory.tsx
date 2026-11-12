import type { ComposerAccessoryProps } from "../../features/conversation/contracts";
import { useThreadTitle } from "../../features/messages/thread-title-store";
import { MessageReplyIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";

/** A thread root's shared title on its timeline row; choosing it opens the
 * thread. Nothing inside the thread, where its tab already carries the name. */
export function TitleAccessory({
  session,
  channelId,
  message,
  openThread,
}: ComposerAccessoryProps) {
  const root =
    message && (!message.threadRootId || message.threadRootId === message.id)
      ? message.id
      : "";
  const title = useThreadTitle(session, channelId, root);
  if (!root || !title || !openThread) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      data-thread-title=""
      aria-label={`Open thread: ${title.title}`}
      onClick={() => openThread()}
    >
      <MessageReplyIcon size="1rem" aria-hidden="true" />
      <span className="text-body-sm">{title.title}</span>
    </Button>
  );
}
