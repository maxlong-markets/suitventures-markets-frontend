import type { Metadata } from "next";
import TokenView from "@/components/TokenView";

interface Props {
  params: Promise<{ ticker: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { ticker } = await params;
  return { title: decodeURIComponent(ticker).toUpperCase() };
}

export default async function TokenPage({ params }: Props) {
  const { ticker } = await params;
  return <TokenView ticker={decodeURIComponent(ticker)} />;
}
