'use client';
import { useEffect, useRef } from 'react';
import { defineDocSlurpSearch } from '@docslurp/sdk/widget';
// Copy into a Next.js app with a release/check-out that provides the widget export.
export function DocumentSearch() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const clientKey = process.env.NEXT_PUBLIC_DOCSLURP_CLIENT_KEY;
    if (!clientKey) throw new Error('Configure a domain-restricted search-only client key.');
    defineDocSlurpSearch();
    const element = document.createElement('docslurp-search-box');
    element.setAttribute('client-key', clientKey);
    // Optional overrides: a named project (slug or UUID; default "default") and the service origin.
    const project = process.env.NEXT_PUBLIC_DOCSLURP_PROJECT;
    if (project) element.setAttribute('project', project);
    if (process.env.NEXT_PUBLIC_DOCSLURP_URL) element.setAttribute('api-url', process.env.NEXT_PUBLIC_DOCSLURP_URL);
    host.current?.append(element);
    return () => element.remove();
  }, []);
  return <div ref={host} />;
}
