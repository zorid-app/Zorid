export interface BaseConfigurationReview {readonly saved:string;readonly desired:string}
/** Review is presentation only: no source transform, host dispatch or save ACK. */
export function reviewRetainedBaseConfiguration(parent:HTMLElement,source:BaseConfigurationReview|undefined,newer:string):void {
  const doc=parent.ownerDocument;
  parent.querySelector('.bases-configuration-review')?.remove();
  const review=doc.createElement('section');review.className='bases-configuration-review';review.dataset.baseReview='true';review.setAttribute('aria-label','Retained configuration changes');
  const message=doc.createElement('p');message.textContent='These changes are retained. Review or copy them before resolving the save conflict.';review.append(message);
  const status=doc.createElement('div');status.setAttribute('role','status');
  const field=(label:string,value:string)=>{
    const heading=doc.createElement('label');heading.textContent=label;
    const text=doc.createElement('textarea');text.readOnly=true;text.value=value;text.rows=5;text.setAttribute('aria-label',label);heading.append(text);
    const copy=doc.createElement('button');copy.type='button';copy.textContent=`Copy ${label.toLowerCase()}`;
    copy.addEventListener('click',()=>{
      text.focus();text.select();
      const clipboard=doc.defaultView?.navigator.clipboard;
      if(clipboard?.writeText)void clipboard.writeText(value).then(()=>{status.textContent='Copied.';},()=>{status.textContent='The retained text is selected. Copy it with your usual keyboard shortcut.';});
      else status.textContent='The retained text is selected. Copy it with your usual keyboard shortcut.';
    });review.append(heading,copy);
  };
  if(source){field('Original saved configuration',source.saved);field('Accepted configuration',source.desired);}
  if(newer)field('Current retained input',newer);
  review.append(status);parent.append(review);review.querySelector('textarea')?.focus();
}
