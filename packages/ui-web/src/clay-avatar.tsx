import atlas from "@tangow/avatars/characters/atlas.webp";
import atlasMini from "@tangow/avatars/characters/atlas-mini.webp";
import docteurDisquette from "@tangow/avatars/characters/docteur-disquette.webp";
import docteurDisquetteMini from "@tangow/avatars/characters/docteur-disquette-mini.webp";
import ivy from "@tangow/avatars/characters/ivy.webp";
import ivyMini from "@tangow/avatars/characters/ivy-mini.webp";
import mariachi from "@tangow/avatars/characters/mariachi.webp";
import mariachiMini from "@tangow/avatars/characters/mariachi-mini.webp";
import monstre from "@tangow/avatars/characters/monstre.webp";
import monstreMini from "@tangow/avatars/characters/monstre-mini.webp";
import roi from "@tangow/avatars/characters/roi.webp";
import roiMini from "@tangow/avatars/characters/roi-mini.webp";
import saintDemon from "@tangow/avatars/characters/saint-demon.webp";
import saintDemonMini from "@tangow/avatars/characters/saint-demon-mini.webp";
import scout from "@tangow/avatars/characters/scout.webp";
import scoutMini from "@tangow/avatars/characters/scout-mini.webp";
import sorciere from "@tangow/avatars/characters/sorciere.webp";
import sorciereMini from "@tangow/avatars/characters/sorciere-mini.webp";
import toutankit from "@tangow/avatars/characters/toutankit.webp";
import toutankitMini from "@tangow/avatars/characters/toutankit-mini.webp";
import viking from "@tangow/avatars/characters/viking.webp";
import vikingMini from "@tangow/avatars/characters/viking-mini.webp";
import type { AvatarCharacter, AvatarCharacterId } from "@tangow/contracts";
import { characterById } from "@tangow/contracts";
import { cn } from "./lib/utils.js";
import "./styles.css";

const MINI_MAX_SIZE = 20;

const IMAGES: Record<AvatarCharacterId, { full: string; mini: string }> = {
  scout: { full: scout, mini: scoutMini },
  atlas: { full: atlas, mini: atlasMini },
  ivy: { full: ivy, mini: ivyMini },
  "saint-demon": { full: saintDemon, mini: saintDemonMini },
  sorciere: { full: sorciere, mini: sorciereMini },
  roi: { full: roi, mini: roiMini },
  mariachi: { full: mariachi, mini: mariachiMini },
  viking: { full: viking, mini: vikingMini },
  monstre: { full: monstre, mini: monstreMini },
  toutankit: { full: toutankit, mini: toutankitMini },
  "docteur-disquette": { full: docteurDisquette, mini: docteurDisquetteMini },
};

/** Whole character when large, face when medium, close on the eyes when small. */
export function cropForSize(size: number): keyof AvatarCharacter["crops"] {
  if (size >= 64) return "full";
  if (size >= 32) return "portrait";
  return "close";
}

/**
 * A clay character in a round disc. A working bot gets the spinning ring in ink, which holds
 * still under reduced motion.
 */
export function ClayAvatar({
  character,
  size,
  isWorking,
  className,
}: {
  character: string | null;
  size: number;
  isWorking: boolean;
  className?: string;
}) {
  const { id, crops } = characterById(character);
  const crop = crops[cropForSize(size)];
  return (
    <div
      className={cn(
        "tangow-bot-avatar tangow-clay-avatar relative flex-none rounded-full select-none",
        className,
      )}
      data-working={isWorking}
      style={{ width: size, height: size }}
    >
      <div className="relative size-full overflow-hidden rounded-full bg-muted">
        <img
          src={IMAGES[id][size <= MINI_MAX_SIZE ? "mini" : "full"]}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="absolute max-w-none"
          style={{
            width: `${(1024 / crop.side) * 100}%`,
            left: `${(-crop.x / crop.side) * 100}%`,
            top: `${(-crop.y / crop.side) * 100}%`,
          }}
        />
      </div>
      <svg
        aria-hidden="true"
        className="tangow-bot-avatar-ring pointer-events-none absolute text-foreground"
        style={{ inset: -4, width: size + 8, height: size + 8 }}
        viewBox="0 0 48 48"
        fill="none"
      >
        <circle
          cx="24"
          cy="24"
          r="22"
          stroke="currentColor"
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeDasharray="45 80"
        />
      </svg>
    </div>
  );
}
