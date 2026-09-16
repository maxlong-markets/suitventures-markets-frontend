import type { Metadata } from "next";
import TokenView from "@/components/TokenView";
import { short } from "@/lib/format";

interface Props {
  params: Promise<{ address: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  return { title: short(decodeURIComponent(address)) };
}

export default async function TokenPage({ params }: Props) {
  const { address } = await params;
  return <TokenView address={decodeURIComponent(address).toLowerCase()} />;
}
