import type { AvatarCharacterId } from "@tangow/contracts";
import { CLAY_MINI_MAX_SIZE, characterById, cropForSize } from "@tangow/contracts";
import { useEffect, useRef } from "react";
import type { ImageSourcePropType } from "react-native";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import Svg, { Circle, Image as SvgImage } from "react-native-svg";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

const IMAGES: Record<AvatarCharacterId, { full: ImageSourcePropType; mini: ImageSourcePropType }> =
  {
    scout: {
      full: require("@tangow/avatars/characters/scout.webp"),
      mini: require("@tangow/avatars/characters/scout-mini.webp"),
    },
    atlas: {
      full: require("@tangow/avatars/characters/atlas.webp"),
      mini: require("@tangow/avatars/characters/atlas-mini.webp"),
    },
    ivy: {
      full: require("@tangow/avatars/characters/ivy.webp"),
      mini: require("@tangow/avatars/characters/ivy-mini.webp"),
    },
    "saint-demon": {
      full: require("@tangow/avatars/characters/saint-demon.webp"),
      mini: require("@tangow/avatars/characters/saint-demon-mini.webp"),
    },
    sorciere: {
      full: require("@tangow/avatars/characters/sorciere.webp"),
      mini: require("@tangow/avatars/characters/sorciere-mini.webp"),
    },
    roi: {
      full: require("@tangow/avatars/characters/roi.webp"),
      mini: require("@tangow/avatars/characters/roi-mini.webp"),
    },
    mariachi: {
      full: require("@tangow/avatars/characters/mariachi.webp"),
      mini: require("@tangow/avatars/characters/mariachi-mini.webp"),
    },
    viking: {
      full: require("@tangow/avatars/characters/viking.webp"),
      mini: require("@tangow/avatars/characters/viking-mini.webp"),
    },
    monstre: {
      full: require("@tangow/avatars/characters/monstre.webp"),
      mini: require("@tangow/avatars/characters/monstre-mini.webp"),
    },
    toutankit: {
      full: require("@tangow/avatars/characters/toutankit.webp"),
      mini: require("@tangow/avatars/characters/toutankit-mini.webp"),
    },
    "docteur-disquette": {
      full: require("@tangow/avatars/characters/docteur-disquette.webp"),
      mini: require("@tangow/avatars/characters/docteur-disquette-mini.webp"),
    },
  };

/** The exported images are cropped from a 1024 px square. */
const SOURCE_SIDE = 1024;
const RING_INSET = 4;

/**
 * A clay character in a round disc, as on web. A working bot gets the spinning ink ring, which
 * holds still under Reduce Motion. The image is drawn in SVG, framed by the crop's viewBox: a
 * native `Image` in the thread's transparent header title blurred the whole thread on iOS 26+.
 * The disc is the translucent `avatarDisc` veil, so it holds over every part of the ambient light.
 */
export function ClayAvatar({
  character,
  size,
  isWorking,
}: {
  character: string | null;
  size: number;
  isWorking: boolean;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const { id, crops } = characterById(character);
  const crop = crops[cropForSize(size)];
  return (
    <View
      style={{ width: size, height: size }}
      accessible={isWorking || undefined}
      accessibilityLabel={isWorking ? t("Working") : undefined}
    >
      <View
        style={[
          styles.disc,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: tokens.avatarDisc },
        ]}
      >
        <Svg width={size} height={size} viewBox={`${crop.x} ${crop.y} ${crop.side} ${crop.side}`}>
          <SvgImage
            href={IMAGES[id][size <= CLAY_MINI_MAX_SIZE ? "mini" : "full"]}
            width={SOURCE_SIDE}
            height={SOURCE_SIDE}
          />
        </Svg>
      </View>
      {isWorking ? <WorkingRing size={size} color={tokens.foreground} /> : null}
    </View>
  );
}

/**
 * On the native driver, like `PulseDot`: a Reanimated rotation would commit the shadow tree on the
 * main thread every frame for as long as the bot works.
 */
function WorkingRing({ size, color }: { size: number; color: string }) {
  const reducedMotion = useReducedMotion();
  const turn = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    turn.setValue(0);
    if (reducedMotion) return;
    const spin = Animated.loop(
      Animated.timing(turn, {
        toValue: 1,
        duration: 1200,
        easing: Easing.bezier(0.4, 0, 0.2, 1),
        useNativeDriver: true,
      }),
    );
    spin.start();
    return () => spin.stop();
  }, [reducedMotion, turn]);

  const side = size + RING_INSET * 2;
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.ring,
        { top: -RING_INSET, left: -RING_INSET, width: side, height: side },
        { transform: [{ rotate }] },
      ]}
    >
      <Svg width={side} height={side} viewBox="0 0 48 48" fill="none">
        <Circle
          cx={24}
          cy={24}
          r={22}
          stroke={color}
          strokeWidth={3.2}
          strokeLinecap="round"
          strokeDasharray="45 80"
        />
      </Svg>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  disc: { overflow: "hidden" },
  ring: { position: "absolute" },
});
