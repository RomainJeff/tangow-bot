import type { AvatarStyle } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  AVATAR_BODY_RADIUS,
  avatarIdentitySeed,
  lerpPose,
  organicAvatarFace,
  organicAvatarPath,
  REST_POSE,
  WORKING_STILL_SECONDS,
  workingPose,
} from "@rakazo/core";
import { memo, useEffect } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, {
  Circle,
  Defs,
  G,
  type GProps,
  Mask,
  Path,
  type PathProps,
  Rect,
} from "react-native-svg";
import { useI18n } from "../lib/i18n";
import { useAvatarStyle } from "./avatar-style";
import { NativeSymbol } from "./native-symbol";

const AnimatedG = Animated.createAnimatedComponent(G);
const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

// react-native-svg leaves `matrix` out of its element props, but the native spec has it.
type Matrix = [number, number, number, number, number, number];
const svgProps = <P extends GProps | PathProps>(props: { matrix: Matrix; opacity?: number }) =>
  props as unknown as Partial<P>;

export const BotAvatar = memo(function BotAvatar({
  color,
  size = 54,
  status,
  identity,
  shapeSeed,
  variant,
  muted = false,
}: {
  color: string;
  size?: number;
  status?: string;
  identity?: string;
  /** Picked organic shape; falls back to a shape derived from `identity`. */
  shapeSeed?: number | null;
  variant?: AvatarStyle;
  muted?: boolean;
}) {
  const { t } = useI18n();
  const isWorking = ACTIVE_RUN_STATUSES.some((activeStatus) => activeStatus === status);
  const { avatarStyle } = useAvatarStyle();
  const visorW = Math.round(size * 0.68);
  const visorH = Math.round(size * 0.44);
  const eyeW = Math.max(3, Math.round(size * 0.11));
  const eyeH = Math.max(4, Math.round(size * 0.17));
  const gap = Math.max(3, Math.round(size * 0.11));
  return (
    <View style={{ width: size, height: size }}>
      {(variant ?? avatarStyle) === "organic" ? (
        <OrganicAvatar
          color={color}
          identity={identity}
          shapeSeed={shapeSeed}
          size={size}
          isWorking={isWorking}
        />
      ) : (
        <View
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: color,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <View
            style={{
              width: visorW,
              height: visorH,
              borderRadius: Math.round(visorH * 0.52),
              backgroundColor: "#0C0C0E",
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap,
            }}
          >
            {[0, 1].map((eye) => (
              <View
                key={eye}
                style={{
                  width: eyeW,
                  height: eyeH,
                  borderRadius: Math.max(2, Math.round(eyeW * 0.6)),
                  backgroundColor: "#fff",
                }}
              />
            ))}
          </View>
        </View>
      )}
      {isWorking ? (
        <View
          accessibilityLabel={t("Working")}
          style={{
            position: "absolute",
            right: muted ? undefined : 0,
            left: muted ? 0 : undefined,
            bottom: 0,
            width: Math.max(6, Math.round(size * 0.18)),
            height: Math.max(6, Math.round(size * 0.18)),
            borderRadius: size,
            backgroundColor: "#F5A03C",
          }}
        />
      ) : null}
      {muted ? (
        <View
          accessible
          accessibilityLabel={t("Notifications silenced")}
          style={{
            position: "absolute",
            right: -2,
            bottom: -2,
            width: Math.max(14, Math.round(size * 0.34)),
            height: Math.max(14, Math.round(size * 0.34)),
            borderRadius: size,
            borderWidth: 2,
            borderColor: "#000",
            backgroundColor: "#242428",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <NativeSymbol
            ios="bell.slash.fill"
            android="notifications-off"
            size={Math.max(8, Math.round(size * 0.17))}
            color="#ECECEE"
          />
        </View>
      ) : null}
    </View>
  );
});

function OrganicAvatar({
  color,
  identity,
  shapeSeed,
  size,
  isWorking,
}: {
  color: string;
  identity?: string;
  shapeSeed?: number | null;
  size: number;
  isWorking: boolean;
}) {
  const seed = shapeSeed ?? avatarIdentitySeed(identity || color || "#8B5CF6");
  const face = organicAvatarFace(seed);
  const reducedMotion = useReducedMotion();
  const clock = useSharedValue(0);
  const working = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(clock);
    working.value = withTiming(isWorking ? 1 : 0, {
      duration: 450,
      easing: Easing.out(Easing.quad),
    });
    if (!isWorking) return;
    if (reducedMotion) {
      clock.value = WORKING_STILL_SECONDS;
      return;
    }
    // ponytail: a linear one-hour clock; a bot working longer restarts its cycle once.
    clock.value = 0;
    clock.value = withTiming(3600, { duration: 3_600_000, easing: Easing.linear });
    return () => cancelAnimation(clock);
  }, [clock, isWorking, reducedMotion, working]);

  const pose = useDerivedValue(() => lerpPose(REST_POSE, workingPose(clock.value), working.value));
  const R = AVATAR_BODY_RADIUS;
  const bodyProps = useAnimatedProps(() =>
    svgProps<PathProps>({
      matrix: [
        pose.value.body.sx,
        0,
        0,
        pose.value.body.sy,
        pose.value.body.x * R,
        pose.value.body.y * R,
      ],
    }),
  );
  const eyesProps = useAnimatedProps(() => {
    const { x, y, roll, opacity } = pose.value.eyes;
    const a = (roll * Math.PI) / 180;
    return {
      opacity,
      matrix: [
        Math.cos(a),
        Math.sin(a),
        -Math.sin(a),
        Math.cos(a),
        face.x + x * R,
        face.y + y * R,
      ] as Matrix,
    };
  });
  const eyeProps = face.eyes.map((eye, i) =>
    // biome-ignore lint/correctness/useHookAtTopLevel: fixed-length list (two eyes)
    useAnimatedProps(() => {
      const [sx, sy] = pose.value.eyes.scale[i]!;
      return svgProps<GProps>({ matrix: [sx, 0, 0, sy, eye.x * (1 - sx), eye.y * (1 - sy)] });
    }),
  );
  const dotProps = [0, 1, 2].map((i) =>
    // biome-ignore lint/correctness/useHookAtTopLevel: fixed-length list (three dots)
    useAnimatedProps(() => {
      const dot = pose.value.dots[i]!;
      return { cx: dot.x * R, cy: dot.y * R, r: dot.r * R, opacity: dot.opacity };
    }),
  );

  return (
    <Svg width={size} height={size} viewBox="-60 -60 120 120">
      <Defs>
        {/* Eyes are holes cut out of the body (bloub): luminance mask, black = hole. */}
        <Mask id="eyes" maskUnits="userSpaceOnUse" x={-60} y={-60} width={120} height={120}>
          <Rect x={-60} y={-60} width={120} height={120} fill="#fff" />
          <AnimatedG animatedProps={eyesProps} fill="#000">
            {face.eyes.map((eye, i) => (
              <AnimatedG key={eye.transform} animatedProps={eyeProps[i]!}>
                <Path d={eye.d} transform={eye.transform} />
              </AnimatedG>
            ))}
          </AnimatedG>
        </Mask>
      </Defs>
      <AnimatedPath
        animatedProps={bodyProps}
        d={organicAvatarPath(seed)}
        fill={color}
        mask="url(#eyes)"
      />
      {dotProps.map((props, i) => (
        <AnimatedCircle key={i} animatedProps={props} fill={color} />
      ))}
    </Svg>
  );
}
