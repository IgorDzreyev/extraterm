/**
 * Map a resource name to a URL.
 *
 * This particular mapping function works in a web context.
 * 
 * @param resourceName relative path to the resource from the main src directory.
 * @return a URL which points to the resource.
 */
export function toUrl(resourceName: string): string {
  return resourceName;
}