import { SegmentedControl } from "@tangow/ui-web";
import { Button } from "@tangow/ui-web/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@tangow/ui-web/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@tangow/ui-web/components/ui/dropdown-menu";
import { Input } from "@tangow/ui-web/components/ui/input";
import { NativeSelect } from "@tangow/ui-web/components/ui/native-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@tangow/ui-web/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@tangow/ui-web/components/ui/tabs";
import { Textarea } from "@tangow/ui-web/components/ui/textarea";
import { Plus } from "lucide-react";
import { createRoot } from "react-dom/client";
import "../../src/styles.css";

const SELECT_ITEMS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
];

function Case() {
  switch (new URLSearchParams(location.search).get("case")) {
    case "buttons":
      return (
        <div className="flex flex-wrap gap-6 p-8">
          {(["icon", "icon-xs", "icon-sm", "icon-lg", "roundIcon", "roundIconSm"] as const).map(
            (size) => (
              <Button key={size} variant="ghost" size={size} aria-label={size} data-testid={size}>
                <Plus />
              </Button>
            ),
          )}
          <div className="relative size-40" data-testid="absolute-host">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="corner"
              data-testid="corner"
              className="absolute top-2 right-2"
            >
              <Plus />
            </Button>
          </div>
        </div>
      );
    case "fields":
      return (
        <div className="flex flex-col gap-4 p-8">
          <Input data-testid="input" />
          <Textarea data-testid="textarea" />
          <NativeSelect data-testid="native-select">
            <option>One</option>
          </NativeSelect>
          <Select items={SELECT_ITEMS} defaultValue="a">
            <SelectTrigger data-testid="select-trigger">
              <SelectValue />
            </SelectTrigger>
          </Select>
        </div>
      );
    case "menu":
      return (
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger>Open</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Pin</DropdownMenuItem>
            <DropdownMenuItem>Archive</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    case "select":
      return (
        <Select items={SELECT_ITEMS} defaultValue="a" defaultOpen>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SELECT_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "segmented":
      return (
        <div className="flex flex-col gap-4 p-8">
          <SegmentedControl
            aria-label="Choice"
            value="a"
            onValueChange={() => {}}
            options={[
              { value: "a", label: "Alpha" },
              { value: "b", label: "Beta" },
            ]}
          />
          <Tabs defaultValue="a">
            <TabsList variant="segmented">
              <TabsTrigger value="a">Alpha</TabsTrigger>
              <TabsTrigger value="b">Beta</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      );
    case "window":
      return (
        <Dialog defaultOpen>
          <DialogContent variant="window" showCloseButton={false}>
            <DialogTitle>Window</DialogTitle>
          </DialogContent>
        </Dialog>
      );
    default:
      return null;
  }
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Case />);
