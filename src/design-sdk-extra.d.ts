declare module '@faclon-labs/design-sdk/UNSPathInput' {
  import type { FC } from 'react';

  type UNSTree = { [key: string]: UNSTree | null };

  export interface UNSPathInputProps {
    label?: string;
    placeholder?: string;
    value: string;
    tree?: UNSTree;
    isLoading?: boolean;
    onChange: (value: string) => void;
    onOpen?: () => void;
  }

  export const UNSPathInput: FC<UNSPathInputProps>;
}
